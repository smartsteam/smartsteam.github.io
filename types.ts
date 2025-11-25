// Web Serial API types augmentation
export interface SerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream | null;
  writable: WritableStream | null;
}

export interface SerialOptions {
  baudRate: number;
}

export type TimeMode = 'relative' | 'absolute';

// Data structures
export interface DataPoint {
  timestamp: number; // Relative time in seconds or absolute
  formattedTime: string;
  [key: string]: number | string; // Allows dynamic series like "temp", "humidity", etc.
}

export interface ExperimentStats {
  min: number;
  max: number;
  avg: number;
  count: number;
  lastValue: number;
}

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}