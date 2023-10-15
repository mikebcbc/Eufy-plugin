/* eslint-disable max-len */
import { EventEmitter, PassThrough, Readable, Writable } from 'stream';
import { Station, Device, StreamMetadata, Camera, EufySecurity } from '@homebridge-eufy-security/eufy-security-client';
import { EufySecurityPlatform } from '../platform';
import { Logger as TsLogger, ILogObj } from 'tslog';
import { CameraAccessory } from '../accessories/CameraAccessory';
import { UniversalStream } from '../utils/utils';

// Define a type for the station stream data.
export type StationStream = {
  station: Station;
  device: Device;
  metadata: StreamMetadata;
  vStream: UniversalStream;
  aStream: UniversalStream;
  createdAt: number;
};

// Define a class for the local livestream manager.
export class LocalLivestreamManager extends EventEmitter {

  private _initSegment: Buffer | null = null;

  private readonly platform: EufySecurityPlatform = this.camera.platform;
  private readonly device: Camera = this.camera.device;
  private readonly log: TsLogger<ILogObj> = this.platform.log;
  private readonly eufyClient: EufySecurity = this.platform.eufyClient;

  private stationStream: StationStream | null = null;
  private livestreamStartedAt: number | null = null;
  private livestreamIsStarting = false;

  constructor(
    private readonly camera: CameraAccessory,
  ) {
    super();
    this.initialize();
    this.eufyClient.on('station livestream stop', this.onStationLivestreamStop.bind(this));
    this.eufyClient.on('station livestream start', this.onStationLivestreamStart.bind(this));
  }

  // Initialize the manager.
  private initialize() {
    this.log.debug(this.camera.name, 'Initialize before livestream.');
    if (this.stationStream) {
      this.log.debug(this.camera.name, 'Cleaning before livestream.');

      this.stationStream.vStream.close();
      this.stationStream.aStream.close();
    }
    this._initSegment = null;
    this.stationStream = null;
    this.livestreamStartedAt = null;
  }

  // Get the local livestream.
  public async getLocalLivestream(): Promise<StationStream> {
    this.log.debug(`${this.device.getName()} New instance requests livestream.`);
    if (this.stationStream) {
      const runtime = (Date.now() - this.livestreamStartedAt!) / 1000;
      this.log.debug(
        this.device.getName(),
        `Using livestream that was started ${runtime} seconds ago.`);
      return this.stationStream;
    } else {
      return await this.startAndGetLocalLiveStream();
    }
  }

  // Start and get the local livestream.
  private async startAndGetLocalLiveStream(): Promise<StationStream> {
    return new Promise((resolve, reject) => {
      this.log.debug(this.device.getName(), 'Start new station livestream...');
      if (!this.livestreamIsStarting) { // prevent multiple stream starts from eufy station
        this.livestreamIsStarting = true;
        this.eufyClient.startStationLivestream(this.device.getSerial());
      } else {
        this.log.debug(this.device.getName(), 'stream is already starting. waiting...');
      }

      this.once('livestream start', async () => {
        if (this.stationStream !== null) {
          this.log.debug(this.device.getName(), 'New livestream started.');
          this.livestreamIsStarting = false;
          resolve(this.stationStream);
        } else {
          reject('no started livestream found');
        }
      });
    });
  }

  // Stop the local livestream.
  public stopLocalLiveStream(): void {
    this.log.debug(this.camera.name, 'Stopping station livestream.');
    this.eufyClient.stopStationLivestream(this.device.getSerial());
    this.initialize();
  }

  // Handle the station livestream stop event.
  private onStationLivestreamStop(station: Station, device: Device) {
    if (device.getSerial() === this.device.getSerial()) {
      this.log.info(`${station.getName()} station livestream for ${device.getName()} has stopped.`);
      this.initialize();
    }
  }

  // Handle the station livestream start event.
  private async onStationLivestreamStart(
    station: Station,
    device: Device,
    metadata: StreamMetadata,
    videostream: Readable,
    audiostream: Readable,
  ) {
    if (device.getSerial() === this.camera.SN) {
      if (this.stationStream) {
        const diff = (Date.now() - this.stationStream.createdAt) / 1000;
        if (diff < 5) {
          this.log.warn(this.camera.name, 'Second livestream was started from station. Ignore.');
          return;
        }
      }
      this.initialize(); // important to prevent unwanted behavior when the eufy station emits the 'livestream start' event multiple times

      this.log.info(`${station.getName()} station livestream (P2P session) for ${this.camera.name} has started.`);
      this.livestreamStartedAt = Date.now();
      const createdAt = Date.now();

      videostream.once('data', (chunk: Buffer) => {
        this._initSegment = chunk;
      });

      const vStream = UniversalStream.StreamInput(this.camera.SN, videostream, this.log);
      const aStream = UniversalStream.StreamInput(this.camera.SN, audiostream, this.log);

      this.stationStream = { station, device, metadata, vStream, aStream, createdAt };

      this.emit('livestream start');
    }
  }

  // Asynchronously wait for the initialization segment.
  public async getInitSegment(): Promise<Buffer> {

    // Return our segment once we've seen it.
    if (this.initSegment) {
      return this.initSegment;
    }

    return this.getInitSegment();
  }

  // Retrieve the initialization segment, if we've seen it.
  public get initSegment(): Buffer | null {
    return this._initSegment;
  }
}