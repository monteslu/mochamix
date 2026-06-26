/**
 * Library data types. A TrackRow is the flattened library + track_locations join
 * the UI displays (05-library-and-data.md §2).
 */

export interface TrackRow {
  id: number;
  location: string;
  filename: string;
  artist: string | null;
  title: string | null;
  album: string | null;
  genre: string | null;
  year: string | null;
  duration: number | null; // seconds
  bitrate: number | null;
  samplerate: number | null;
  bpm: number;
  firstBeatFrame: number;
  key: string | null;
  rating: number;
  color: number | null;
  dateAdded: string;
  timesPlayed: number;
  filetype: string | null;
  /** Path to the generated NI-Stems .stem.mp4, or null if stems not generated. */
  stemPath: string | null;
  /** Epoch ms when stems were generated; 0 = not generated. */
  stemsGeneratedAt: number;
}

/** Fields settable when inserting/updating a track. */
export interface TrackInput {
  location: string;
  filename?: string;
  directory?: string;
  filesize?: number;
  artist?: string | null;
  title?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  genre?: string | null;
  composer?: string | null;
  comment?: string | null;
  year?: string | null;
  trackNumber?: string | null;
  duration?: number | null;
  bitrate?: number | null;
  samplerate?: number | null;
  channels?: number | null;
  filetype?: string | null;
}

/** Cue types — mirror Mixxx CueType (05 §2.4). */
export enum CueType {
  Invalid = 0,
  HotCue = 1,
  MainCue = 2,
  Loop = 4,
  Intro = 6,
  Outro = 7,
}

export interface CueRow {
  id: number;
  trackId: number;
  type: CueType;
  position: number;
  length: number;
  hotcue: number;
  label: string | null;
  color: number | null;
}
