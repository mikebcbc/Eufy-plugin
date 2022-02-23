/* eslint-disable indent */
import {
    API,
    APIEvent,
    AudioStreamingCodecType,
    AudioStreamingSamplerate,
    CameraController,
    CameraControllerOptions,
    CameraStreamingDelegate,
    HAP,
    PrepareStreamCallback,
    PrepareStreamRequest,
    PrepareStreamResponse,
    SnapshotRequest,
    SnapshotRequestCallback,
    SRTPCryptoSuites,
    StartStreamRequest,
    StreamingRequest,
    StreamRequestCallback,
    StreamRequestTypes,
    VideoInfo
} from 'homebridge';
import { spawn } from 'child_process';
import { createSocket, Socket } from 'dgram';
import ffmpegPath from 'ffmpeg-for-homebridge';
import pickPort, { pickPortOptions } from 'pick-port';
import { CameraConfig, VideoConfig } from './configTypes';
import { FfmpegProcess } from './ffmpeg';
import { Logger } from './logger';

import { Station, Camera, PropertyName, StreamMetadata, VideoCodec } from 'eufy-security-client';
import { EufySecurityPlatform } from '../platform';

import { Readable } from 'stream';
import { NamePipeStream, StreamInput } from './UniversalStream';

import { readFile } from 'fs'
import fs from 'fs'
import { promisify } from 'util'
const readFileAsync = promisify(readFile),
    SnapshotUnavailablePath = require.resolve('../../media/Snapshot-Unavailable.png');

type SessionInfo = {
    address: string; // address of the HAP controller
    ipv6: boolean;

    videoPort: number;
    videoReturnPort: number;
    videoCryptoSuite: SRTPCryptoSuites; // should be saved if multiple suites are supported
    videoSRTP: Buffer; // key and salt concatenated
    videoSSRC: number; // rtp synchronisation source

    audioPort: number;
    audioReturnPort: number;
    audioCryptoSuite: SRTPCryptoSuites;
    audioSRTP: Buffer;
    audioSSRC: number;
};

type ResolutionInfo = {
    width: number;
    height: number;
    videoFilter?: string;
    snapFilter?: string;
    resizeFilter?: string;
};

type ActiveSession = {
    mainProcess_video?: FfmpegProcess;
    mainProcess_audio?: FfmpegProcess;
    timeout?: NodeJS.Timeout;
    vsocket?: Socket;
    asocket?: Socket;
    uVideoStream?: NamePipeStream;
    uAudioStream?: NamePipeStream;

};

type StationStream = {
    station: Station;
    channel: number;
    metadata: StreamMetadata;
    videostream: Readable;
    audiostream: Readable;
};

export class StreamingDelegate implements CameraStreamingDelegate {
    private readonly hap: HAP;
    private readonly api: API;
    private readonly log: Logger;
    private readonly cameraName: string;
    private readonly unbridge: boolean;
    private readonly videoConfig: VideoConfig;
    private readonly videoProcessor: string;
    readonly controller: CameraController;
    private snapshotPromise?: Promise<Buffer>;
    private stationStream: StationStream | undefined;

    private readonly platform: EufySecurityPlatform;
    private readonly device: Camera;

    private readonly eufyPath: string;

    // keep track of sessions
    pendingSessions: Map<string, SessionInfo> = new Map();
    ongoingSessions: Map<string, ActiveSession> = new Map();
    timeouts: Map<string, NodeJS.Timeout> = new Map();

    constructor(platform: EufySecurityPlatform, device: Camera, cameraConfig: CameraConfig, api: API, hap: HAP) { // eslint-disable-line @typescript-eslint/explicit-module-boundary-types
        this.log = platform.log;
        this.hap = hap;
        this.api = api;

        this.eufyPath = this.api.user.storagePath() + '/eufysecurity';

        if (!fs.existsSync(this.eufyPath)) {
            fs.mkdirSync(this.eufyPath);
        }

        this.platform = platform;
        this.device = device;

        this.cameraName = device.getName()!;
        this.unbridge = false;
        this.videoConfig = cameraConfig.videoConfig!;
        this.videoProcessor = ffmpegPath || 'ffmpeg';

        this.api.on(APIEvent.SHUTDOWN, () => {
            for (const session in this.ongoingSessions) {
                this.stopStream(session);
            }
        });

        const options: CameraControllerOptions = {
            cameraStreamCount: this.videoConfig.maxStreams || 2, // HomeKit requires at least 2 streams, but 1 is also just fine
            delegate: this,
            streamingOptions: {
                supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
                video: {
                    resolutions: [
                        [320, 180, 30],
                        [320, 240, 15], // Apple Watch requires this configuration
                        [320, 240, 30],
                        [480, 270, 30],
                        [480, 360, 30],
                        [640, 360, 30],
                        [640, 480, 30],
                        [1280, 720, 30],
                        [1280, 960, 30],
                        [1920, 1080, 30],
                        [1600, 1200, 30]
                    ],
                    codec: {
                        profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
                        levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0]
                    }
                },
                audio: {
                    twoWayAudio: !!this.videoConfig.returnAudioTarget,
                    codecs: [
                        {
                            type: AudioStreamingCodecType.AAC_ELD,
                            samplerate: AudioStreamingSamplerate.KHZ_16
                            /*type: AudioStreamingCodecType.OPUS,
                            samplerate: AudioStreamingSamplerate.KHZ_24*/
                        }
                    ]
                }
            }
        };

        this.controller = new hap.CameraController(options);
    }

    private determineResolution(request: SnapshotRequest | VideoInfo, isSnapshot: boolean): ResolutionInfo {
        const resInfo: ResolutionInfo = {
            width: request.width,
            height: request.height
        };
        if (!isSnapshot) {
            if (this.videoConfig.maxWidth !== undefined &&
                (this.videoConfig.forceMax || request.width > this.videoConfig.maxWidth)) {
                resInfo.width = this.videoConfig.maxWidth;
            }
            if (this.videoConfig.maxHeight !== undefined &&
                (this.videoConfig.forceMax || request.height > this.videoConfig.maxHeight)) {
                resInfo.height = this.videoConfig.maxHeight;
            }
        }

        const filters: Array<string> = this.videoConfig.videoFilter?.split(',') || [];
        const noneFilter = filters.indexOf('none');
        if (noneFilter >= 0) {
            filters.splice(noneFilter, 1);
        }
        resInfo.snapFilter = filters.join(',');
        if ((noneFilter < 0) && (resInfo.width > 0 || resInfo.height > 0)) {
            resInfo.resizeFilter = 'scale=' + (resInfo.width > 0 ? '\'min(' + resInfo.width + ',iw)\'' : 'iw') + ':' +
                (resInfo.height > 0 ? '\'min(' + resInfo.height + ',ih)\'' : 'ih') +
                ':force_original_aspect_ratio=decrease';
            filters.push(resInfo.resizeFilter);
            filters.push('scale=\'trunc(iw/2)*2:trunc(ih/2)*2\''); // Force to fit encoder restrictions
        }

        if (filters.length > 0) {
            resInfo.videoFilter = filters.join(',');
        }

        return resInfo;
    }

    private async getLocalLiveStream(): Promise<StationStream> {
        return new Promise((resolve, reject) => {
            const station = this.platform.getStationById(this.device.getStationSerial());
            this.platform.eufyClient.startStationLivestream(this.device.getSerial());

            station.on('livestream start', (station: Station, channel: number, metadata: StreamMetadata,
                videostream: Readable, audiostream: Readable) => {
                if (this.platform.eufyClient.getStationDevice(station.getSerial(), channel).getSerial() === this.device.getSerial()) {
                    const stationStream: StationStream = { station, channel, metadata, videostream, audiostream };
                    this.stationStream = stationStream;
                    resolve(stationStream);
                }
            });
        });
    }

    fetchSnapshot(snapFilter?: string): Promise<Buffer> {

        return new Promise(async (resolve, reject) => {

            try {
                // try {
                //     this.videoConfig.stillImageSource = '-i ' + this.device.getPropertyValue(PropertyName.DevicePictureUrl).value as string;
                // } catch {
                //     this.log.warn(this.cameraName + ' fetchSnapshot: ' + 'No Snapshot found');
                //     resolve(await readFileAsync(SnapshotUnavailablePath));
                // }


                // const ffmpegArgs = (this.videoConfig.stillImageSource || this.videoConfig.source!) + // Still
                // ' -frames:v 1' +
                // (snapFilter ? ' -filter:v ' + snapFilter : '') +
                // ' -f image2 -' +
                // ' -hide_banner' +
                // ' -loglevel ' + (this.platform.config.enableDetailedLogging >= 1 ? '+verbose' : 'error');

                const streamData = await this.getLocalLiveStream().catch(err => {
                    throw err;
                });

                this.log.debug('Received local livestream.');

                const startTime = Date.now();
                const ffmpegArgs = '-probesize 3000 -analyzeduration 0 -ss 00:00:00.500 -i pipe: -frames:v 1 -c:v copy' +
                    (snapFilter ? ' -filter:v ' + snapFilter : '') +
                    ' -f image2 -' +
                    ' -hide_banner' +
                    ' -loglevel ' + (this.platform.config.enableDetailedLogging >= 1 ? '+verbose' : 'error');

                this.log.debug(this.cameraName, 'Snapshot command: ' + this.videoProcessor + ' ' + ffmpegArgs, this.videoConfig.debug);
                const ffmpeg = spawn(this.videoProcessor, ffmpegArgs.split(/\s+/), { env: process.env });
                streamData.videostream.pipe(ffmpeg.stdin).on('error', (err) => {
                    this.log.error(err.message, this.cameraName);
                });

                let snapshotBuffer = Buffer.alloc(0);
                ffmpeg.stdout.on('data', (data) => {
                    snapshotBuffer = Buffer.concat([snapshotBuffer, data]);
                });
                ffmpeg.on('error', (error: Error) => {
                    reject('FFmpeg process creation failed: ' + error.message);
                });
                ffmpeg.stderr.on('data', (data) => {
                    data.toString().split('\n').forEach((line: string) => {
                        if (this.videoConfig.debug && line.length > 0) { // For now only write anything out when debug is set
                            this.log.error(line, this.cameraName + '] [Snapshot');
                        }
                    });
                });
                ffmpeg.on('close', () => {
                    if (snapshotBuffer.length > 0) {
                        resolve(snapshotBuffer);
                    } else {
                        reject('Failed to fetch snapshot.');
                    }

                    this.platform.eufyClient.stopStationLivestream(this.device.getSerial());

                    setTimeout(() => {
                        this.log.debug('Setting snapshotPromise to undefined.');
                        this.snapshotPromise = undefined;
                    }, 3 * 1000); // Expire cached snapshot after 3 seconds

                    const runtime = (Date.now() - startTime) / 1000;
                    let message = 'Fetching snapshot took ' + runtime + ' seconds.';
                    if (runtime < 5) {
                        this.log.debug(message, this.cameraName, this.videoConfig.debug);
                    } else {
                        if (!this.unbridge) {
                            message += ' It is highly recommended you switch to unbridge mode.';
                        }
                        if (runtime < 22) {
                            this.log.warn(message, this.cameraName);
                        } else {
                            message += ' The request has timed out and the snapshot has not been refreshed in HomeKit.';
                            this.log.error(message, this.cameraName);
                        }
                    }
                });
            } catch (err) {
                this.log.error(this.cameraName, err as string);
                reject('Failed to fetch snapshot.');
            }
        });
    }

    resizeSnapshot(snapshot: Buffer, resizeFilter?: string): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            const ffmpegArgs = '-i pipe:' + // Resize
                ' -frames:v 1' +
                (resizeFilter ? ' -filter:v ' + resizeFilter : '') +
                ' -f image2 -';

            this.log.debug(this.cameraName, 'Resize command: ' + this.videoProcessor + ' ' + ffmpegArgs, this.videoConfig.debug);
            const ffmpeg = spawn(this.videoProcessor, ffmpegArgs.split(/\s+/), { env: process.env });

            let resizeBuffer = Buffer.alloc(0);
            ffmpeg.stdout.on('data', (data) => {
                resizeBuffer = Buffer.concat([resizeBuffer, data]);
            });
            ffmpeg.on('error', (error: Error) => {
                reject('FFmpeg process creation failed: ' + error.message);
            });
            ffmpeg.on('close', () => {
                resolve(resizeBuffer);
            });
            ffmpeg.stdin.end(snapshot);
        });
    }

    async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
        this.log.debug('handleSnapshotRequest');
        this.log.debug('snapshotPromise: ' + !!this.snapshotPromise);
        const resolution = this.determineResolution(request, true);

        try {
            const cachedSnapshot = !!this.snapshotPromise;

            this.log.debug('Snapshot requested: ' + request.width + ' x ' + request.height,
                this.cameraName, this.videoConfig.debug);

            const snapshot = await (this.snapshotPromise || this.fetchSnapshot(resolution.snapFilter));
            // let snapshot;
            // if(this.snapshotPromise) {
            //     this.log.debug('Awaiting promise');
            //     snapshot = await this.snapshotPromise;
            // } else{
            //     this.log.debug('Calling fetchSnapshot');
            //     snapshot = await this.fetchSnapshot(resolution.snapFilter);
            // }

            this.log.debug('snapshot byte lenght: ' + snapshot?.byteLength);

            this.log.debug('Sending snapshot: ' + (resolution.width > 0 ? resolution.width : 'native') + ' x ' +
                (resolution.height > 0 ? resolution.height : 'native') +
                (cachedSnapshot ? ' (cached)' : ''), this.cameraName, this.videoConfig.debug);

            const resized = await this.resizeSnapshot(snapshot, resolution.resizeFilter);
            callback(undefined, resized);
        } catch (err) {
            this.log.error(this.cameraName, err as string);
            callback();
        }
    }

    async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
        const ipv6 = request.addressVersion === 'ipv6';

        const options: pickPortOptions = {
            type: 'udp',
            ip: ipv6 ? '::' : '0.0.0.0',
            reserveTimeout: 15
        };
        const videoReturnPort = await pickPort(options);
        const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
        const audioReturnPort = await pickPort(options);
        const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

        const sessionInfo: SessionInfo = {
            address: request.targetAddress,
            ipv6: ipv6,

            videoPort: request.video.port,
            videoReturnPort: videoReturnPort,
            videoCryptoSuite: request.video.srtpCryptoSuite,
            videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
            videoSSRC: videoSSRC,

            audioPort: request.audio.port,
            audioReturnPort: audioReturnPort,
            audioCryptoSuite: request.audio.srtpCryptoSuite,
            audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
            audioSSRC: audioSSRC
        };

        const response: PrepareStreamResponse = {
            video: {
                port: videoReturnPort,
                ssrc: videoSSRC,

                srtp_key: request.video.srtp_key,
                srtp_salt: request.video.srtp_salt
            },
            audio: {
                port: audioReturnPort,
                ssrc: audioSSRC,

                srtp_key: request.audio.srtp_key,
                srtp_salt: request.audio.srtp_salt
            }
        };

        this.pendingSessions.set(request.sessionID, sessionInfo);
        callback(undefined, response);
    }

    private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {

        try {
            const streamData = await this.getLocalLiveStream().catch(err => {
                throw err;
            });

            this.log.debug('ReqHK:', JSON.stringify(request));
            this.log.debug('ReqEufy:', JSON.stringify(streamData.metadata));

            const uVideoStream = StreamInput(streamData.videostream, this.cameraName + '_video', this.eufyPath, this.log);

            const sessionInfo = this.pendingSessions.get(request.sessionID);
            if (sessionInfo) {
                const vcodec = this.videoConfig.vcodec || 'libx264';
                const mtu = this.videoConfig.packetSize || 1316; // request.video.mtu is not used
                let encoderOptions = this.videoConfig.encoderOptions;
                if (!encoderOptions && vcodec === 'libx264') {
                    encoderOptions = '-preset ultrafast -tune zerolatency';
                }

                const resolution = this.determineResolution(request.video, false);

                let fps = (this.videoConfig.maxFPS !== undefined &&
                    (this.videoConfig.forceMax || request.video.fps > this.videoConfig.maxFPS)) ?
                    this.videoConfig.maxFPS : request.video.fps;
                let videoBitrate = (this.videoConfig.maxBitrate !== undefined &&
                    (this.videoConfig.forceMax || request.video.max_bit_rate > this.videoConfig.maxBitrate)) ?
                    this.videoConfig.maxBitrate : request.video.max_bit_rate;

                if (vcodec === 'copy') {
                    resolution.width = 0;
                    resolution.height = 0;
                    resolution.videoFilter = undefined;
                    fps = 0;
                    videoBitrate = 0;
                }

                this.log.debug(this.cameraName, 'Video stream requested: ' + request.video.width + ' x ' + request.video.height + ', ' +
                    request.video.fps + ' fps, ' + request.video.max_bit_rate + ' kbps', this.videoConfig.debug);
                this.log.info(this.cameraName, 'Starting video stream: ' + (resolution.width > 0 ? resolution.width : 'native') + ' x ' +
                    (resolution.height > 0 ? resolution.height : 'native') + ', ' + (fps > 0 ? fps : 'native') +
                    ' fps, ' + (videoBitrate > 0 ? videoBitrate : '???') + ' kbps' +
                    (this.videoConfig.audio ? (' (' + request.audio.codec + ')') : ''));

                let ffmpegArgs_video = [''];

                ffmpegArgs_video.push('-use_wallclock_as_timestamps 1');

                ffmpegArgs_video.push((streamData.metadata.videoCodec === 0) ? '-f h264' : '');
                ffmpegArgs_video.push(`-r ${streamData.metadata.videoFPS}`);
                ffmpegArgs_video.push(`-i ${uVideoStream.url}`);

                ffmpegArgs_video.push( // Video
                    (this.videoConfig.mapvideo ? '-map ' + this.videoConfig.mapvideo : '-an -sn -dn'),
                    '-codec:v ' + vcodec,
                    '-pix_fmt yuv420p',
                    '-color_range mpeg',
                    (fps > 0 ? '-r ' + fps : ''),
                    (encoderOptions || ''),
                    (resolution.videoFilter ? '-filter:v ' + resolution.videoFilter : ''),
                    (videoBitrate > 0 ? '-b:v ' + videoBitrate + 'k' : ''),
                    '-payload_type ' + request.video.pt,
                );

                ffmpegArgs_video.push( // Video Stream
                    '-ssrc ' + sessionInfo.videoSSRC,
                    '-f rtp',
                    '-srtp_out_suite AES_CM_128_HMAC_SHA1_80',
                    '-srtp_out_params ' + sessionInfo.videoSRTP.toString('base64'),
                    'srtp://' + sessionInfo.address + ':' + sessionInfo.videoPort +
                    '?rtcpport=' + sessionInfo.videoPort + '&pkt_size=' + mtu,
                );

                ffmpegArgs_video.push(
                    '-loglevel ' + (this.platform.config.enableDetailedLogging >= 1 ? '+verbose' : 'error'),
                    '-progress pipe:1',
                );

                const clean_ffmpegArgs_video = ffmpegArgs_video.filter(function (el) { return el; });

                const activeSession: ActiveSession = {};

                activeSession.vsocket = createSocket(sessionInfo.ipv6 ? 'udp6' : 'udp4');
                activeSession.vsocket.on('error', (err: Error) => {
                    this.log.error(this.cameraName, 'Socket error: ' + err.message);
                    this.stopStream(request.sessionID);
                });
                activeSession.vsocket.on('message', () => {
                    if (activeSession.timeout) {
                        clearTimeout(activeSession.timeout);
                    }
                    activeSession.timeout = setTimeout(() => {
                        this.log.info(this.cameraName, 'Device appears to be inactive. Stopping video stream.');
                        this.controller.forceStopStreamingSession(request.sessionID);
                        this.stopStream(request.sessionID);
                    }, request.video.rtcp_interval * 5 * 1000);
                });
                activeSession.vsocket.bind(sessionInfo.videoReturnPort);

                activeSession.uVideoStream = uVideoStream;

                activeSession.mainProcess_video = new FfmpegProcess(this.cameraName + '_video', request.sessionID, this.videoProcessor,
                    clean_ffmpegArgs_video, this.log, this.videoConfig.debug, this, callback);

                // Required audio came to early so end user will see a lag of the video
                await new Promise((resolve) => { setTimeout(resolve, 6000); });

                const uAudioStream = StreamInput(streamData.audiostream, this.cameraName + '_audio', this.eufyPath, this.log);

                let ffmpegArgs_audio = [''];

                ffmpegArgs_audio.push(`-i ${uAudioStream.url}`);

                if (request.audio.codec === AudioStreamingCodecType.OPUS || request.audio.codec === AudioStreamingCodecType.AAC_ELD) {
                    ffmpegArgs_audio.push( // Audio
                        (this.videoConfig.mapaudio ? '-map ' + this.videoConfig.mapaudio : '-vn -sn -dn'),
                        (request.audio.codec === AudioStreamingCodecType.OPUS ?
                            '-codec:a libopus' + ' -application lowdelay' :
                            '-codec:a libfdk_aac' + ' -profile:a aac_eld'),
                        '-flags +global_header',
                        '-ar ' + request.audio.sample_rate + 'k',
                        '-b:a ' + request.audio.max_bit_rate + 'k',
                        '-ac ' + request.audio.channel,
                        '-payload_type ' + request.audio.pt,
                    );

                    ffmpegArgs_audio.push( // Audio Stream
                        '-ssrc ' + sessionInfo.audioSSRC,
                        '-f rtp',
                        '-srtp_out_suite AES_CM_128_HMAC_SHA1_80',
                        '-srtp_out_params ' + sessionInfo.audioSRTP.toString('base64'),
                        'srtp://' + sessionInfo.address + ':' + sessionInfo.audioPort +
                        '?rtcpport=' + sessionInfo.audioPort + '&pkt_size=188',
                    );

                    ffmpegArgs_audio.push(
                        '-loglevel ' + (this.platform.config.enableDetailedLogging >= 1 ? '+verbose' : 'error'),
                        '-progress pipe:1',
                    );

                    const clean_ffmpegArgs_audio = ffmpegArgs_audio.filter(function (el) { return el; });

                    activeSession.asocket = createSocket(sessionInfo.ipv6 ? 'udp6' : 'udp4');
                    activeSession.asocket.on('error', (err: Error) => {
                        this.log.error(this.cameraName, 'Socket error: ' + err.message);
                        this.stopStream(request.sessionID);
                    });
                    activeSession.asocket.on('message', () => {
                        if (activeSession.timeout) {
                            clearTimeout(activeSession.timeout);
                        }
                        activeSession.timeout = setTimeout(() => {
                            this.log.info(this.cameraName, 'Device appears to be inactive. Stopping audio stream.');
                            this.controller.forceStopStreamingSession(request.sessionID);
                            this.stopStream(request.sessionID);
                        }, request.audio.rtcp_interval * 5 * 1000);
                    });
                    activeSession.asocket.bind(sessionInfo.audioReturnPort);

                    activeSession.uAudioStream = uAudioStream;

                    activeSession.mainProcess_audio = new FfmpegProcess(this.cameraName + '_audio', request.sessionID, this.videoProcessor,
                        clean_ffmpegArgs_audio, this.log, this.videoConfig.debug, this);

                } else {
                    this.log.error(this.cameraName, 'Unsupported audio codec requested: ' + request.audio.codec);
                }

                // streamData.station.on('livestream stop', (station: Station, channel: number) => {
                //     if (this.platform.eufyClient.getStationDevice(station.getSerial(), channel).getSerial() === this.device.getSerial()) {
                //         this.log.info(this.cameraName, 'Eufy Station stopped the stream. Stopping stream.');
                //         this.controller.forceStopStreamingSession(request.sessionID);
                //         this.stopStream(request.sessionID);
                //     }
                // });

                // Check if the pendingSession has been stopped before it was successfully started.
                const pendingSession = this.pendingSessions.get(request.sessionID);
                // pendingSession has not been deleted. Transfer it to ongoingSessions.
                if (pendingSession) {
                    this.ongoingSessions.set(request.sessionID, activeSession);
                    this.pendingSessions.delete(request.sessionID);
                }
                // pendingSession has been deleted. Add it to ongoingSession and end it immediately.
                else {
                    this.ongoingSessions.set(request.sessionID, activeSession);
                    this.log.info(this.cameraName, 'pendingSession has been deleted. Add it to ongoingSession and end it immediately.');
                    this.stopStream(request.sessionID);
                }
            } else {
                this.log.error(this.cameraName, 'Error finding session information.');
                callback(new Error('Error finding session information'));
            }

        } catch (err) {
            this.log.error(this.cameraName + ' Unable to start the livestream: ' + err as string);
        }
    }

    handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
        switch (request.type) {
            case StreamRequestTypes.START:
                this.startStream(request, callback);
                break;
            case StreamRequestTypes.RECONFIGURE:
                this.log.debug(this.cameraName, 'Received request to reconfigure: ' + request.video.width + ' x ' + request.video.height + ', ' +
                    request.video.fps + ' fps, ' + request.video.max_bit_rate + ' kbps (Ignored)', this.videoConfig.debug);
                callback();
                break;
            case StreamRequestTypes.STOP:
                this.log.info(this.cameraName, 'Receive Apple HK Stop request'+JSON.stringify(request));
                this.stopStream(request.sessionID);
                callback();
                break;
        }
    }

    public stopStream(sessionId: string): void {
        this.log.info('Stopping session with id: ' + sessionId);

        const pendingSession = this.pendingSessions.get(sessionId);
        if (pendingSession) {
            this.pendingSessions.delete(sessionId);
        }

        const session = this.ongoingSessions.get(sessionId);
        if (session) {
            if (session.timeout) {
                clearTimeout(session.timeout);
            }
            try {
                session.mainProcess_video?.stop();
                session.mainProcess_audio?.stop();
            } catch (err) {
                this.log.error(this.cameraName, 'Error occurred terminating main FFmpeg process: ' + err);
            }
            try {
                session.vsocket?.close();
                session.asocket?.close();
            } catch (err) {
                this.log.error(this.cameraName, 'Error occurred closing socket: ' + err);
            }
            try {
                session.uVideoStream?.close();
                session.uAudioStream?.close();
            } catch (err) {
                this.log.error(this.cameraName, 'Error occurred Universal Stream: ' + err);
            }
            try {
                this.platform.eufyClient.stopStationLivestream(this.device.getSerial());
            } catch (err) {
                this.log.error(this.cameraName, 'Error occurred terminating Eufy Station livestream: ' + err);
            }

            this.ongoingSessions.delete(sessionId);
            this.log.info(this.cameraName, 'Stopped video stream.');
        }
        else {
            this.log.debug('No session to stop.')
        }

    }
}
