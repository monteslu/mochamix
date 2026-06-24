# 01 — Mixxx Overview & Complete Feature List

The product spec we are cloning. Sourced from <https://mixxx.org/>, the features page, and the manual.

## 1. What Mixxx is

- **Elevator pitch:** "Free and open source DJ software for Windows, macOS, and Linux." Integrates the
  tools needed to perform creative live mixes with digital music files.
- **License:** GNU GPL v2-or-later. "Mixxx is and always will be free."
- **Platforms:** Windows, macOS, Linux.
- **Audience:** bedroom/laptop DJs through professional turntablists.
- **History:** founded 2001; was the #1 Top Free Mac App worldwide on the Mac App Store (Feb 2011);
  built by an international community of DJs, programmers, and artists.

## 2. Complete advertised feature list

From the features page (each is a target capability for internal-dj):

| # | Feature | Description |
|---|---------|-------------|
| 1 | **Four Decks** | Drop a song onto any of four decks; scrolling waveforms and beat markers. |
| 2 | **Pitch and Key Control** | Adjust tempo without changing pitch (keylock), or change pitch while keeping sync (harmonic). |
| 3 | **Beat Looping** | Instantly loop a 4/8/16-beat segment; save loops to hotcue slots. |
| 4 | **Sync Lock** | Engage on decks so they stay beat-locked even as you change speed. |
| 5 | **Hotcues** | Mark places in tracks for rapid-fire triggering during remixes. |
| 6 | **Beat Rolls & Censor** | Trigger short loops and reverse-playback effects while staying beat-synced. |
| 7 | **Quantization** | Cues and loops snap exactly on beat. |
| 8 | **Broad Format Support** | Lossless FLAC/WAV/AIFF + lossy MP3, M4A/AAC, Ogg Vorbis, Opus. |
| 9 | **EQ & Crossfader Control** | Multiple EQs with adjustable shelves; customizable crossfader curves. |
| 10 | **MIDI & HID Controller Support** | Bundled presets for many controllers + a programmable JS mapping engine. |
| 11 | **Free Timecode Vinyl Control (DVS)** | Control digital files with turntables/CDJs via timecoded vinyl/CDs. |
| 12 | **Sampler Decks** | Up to **64 sampler decks** of sounds to layer over the mix. |
| 13 | **Effects Chains** | Chain up to **3 effects** with customizable parameters + metaknob control. |
| 14 | **Crates & Playlists** | User-defined categorization and set-planning tools. |
| 15 | **Search & Sort** | Type to find a track; hierarchical multi-column sort. |
| 16 | **MusicBrainz Tag Lookup** | Fingerprint tracks to fetch missing metadata. |
| 17 | **External DJ Library Integration** | Import from iTunes, Traktor, Banshee, Rekordbox, Rhythmbox, Serato. |
| 18 | **BPM Detection** | Identifies the beat in complex rhythms. |
| 19 | **Key Detection** | Musical key detection for harmonic mixing. |
| 20 | **Auto DJ** | Build a playlist and let Auto DJ crossfade automatically. |
| 21 | **Multiple Skins** | Four themes: **Deere, LateNight, Shade, Tango**. |
| 22 | **Recording** | Capture mixes to lossless WAV/FLAC, lossy Ogg, or MP3 (LAME). |
| 23 | **Live Broadcasting** | Stream to **Shoutcast or Icecast**. |
| 24 | **ReplayGain Normalization** | Consistent loudness across the mix. |
| 25 | **Mic & Aux Inputs** | **4 microphone + 4 auxiliary inputs**, with latency compensation. |
| 26 | **Native Language Support** | Localized into Spanish, French, German, Italian, Russian, Japanese, and more. |

## 3. Supported file formats

- **Playback (lossless):** FLAC, WAV, AIFF.
- **Playback (lossy):** MP3, M4A/AAC, Ogg Vorbis, Opus.
- **Recording output:** WAV, AIFF, FLAC (lossless); Ogg Vorbis, MP3, Opus (lossy).
- **Library import (read external DBs):** iTunes, Traktor, Banshee, Rekordbox, Rhythmbox, Serato.
- **Metadata:** MusicBrainz acoustic fingerprinting / tag lookup.
- **No inbound streaming services.** No Beatport / SoundCloud / Tidal integration. "Streaming" in
  Mixxx means *outbound* broadcasting to Shoutcast/Icecast, not inbound subscriptions. Local files
  only. (This is a potential differentiator for internal-dj.)

## 4. Hardware / controller support

- **Open hardware philosophy:** any audio interface and any MIDI/HID controller the OS has drivers
  for. Not vendor-locked.
- **Bundled mappings:** ~150 officially bundled controllers (the cloned tree has **163 mapping XMLs +
  152 JS files** in `res/controllers/`), spanning Pioneer, Numark, Hercules, Native Instruments,
  Reloop, Denon, Behringer, Vestax, Novation, Korg, M-Audio, Akai, Allen & Heath, and many more.
- **Mapping tiers:** *Mixxx Certified* (QA'd) and *Community Supported*.
- **Mapping engine:** XML + JavaScript (QJSEngine). 2.6 added a **screen renderer** for controllers
  with built-in screens, plus file/color controller setting types.
- **Multiple audio interfaces** can be used simultaneously (internal-mixing or external-mixer modes).
- **Timecode vinyl / DVS** (free, built-in): Serato CV02 / 2.5 Vinyl, Serato Control CD, Traktor
  Scratch MK1, MixVibes DVS V2, Pioneer Rekordbox DVS. Up to 4 timecode decks. Needs a multi-input
  DJ audio interface (≥4 input channels, line level).

## 5. Versions & roadmap

- **Current stable: Mixxx 2.5.6** (March 2026, the final 2.5 release).
- **2.6** (beta as of mid-2025; what the manual we studied documents) major adds:
  - **STEM file support** — independently control volume + effects for 4 stems (Drums, Bass, Melody,
    Vocals); on-the-fly acapellas / remixes / per-stem effects.
  - **Cue management** — drag to reposition cues, auto-arrange by position, drag hotcue onto play.
  - **Library** — Key column color coding + Key Color Palettes, waveform overview column,
    `bpm:locked` search filter.
  - **Waveform** — minute markers on the overview, simplified waveform prefs.
  - **Controllers** — screen renderer, file/color setting types, updated mappings.
- **Mixxx 3.0 / the QML project** (announced 2025): a full UI rewrite from QWidget to **QML** (Qt's
  declarative language). Modernized library/waveform views, built-in accessibility, interactive
  settings, optimization for tablets/touchscreens. Phases out the homemade XML theme system. **This
  is directly relevant to us — it is essentially Mixxx moving to a declarative, web-like UI binding
  model, which is exactly what an Electron renderer is.** See `06-ui-controllers-effects.md` §QML.

## 6. Community / ecosystem (how the project sustains itself)

- **Chat:** Zulip (`mixxx.zulipchat.com`), 3000+ members.
- **Forum:** Mixxx Discourse.
- **Code:** GitHub `mixxxdj/mixxx` + a community wiki (controller mapping docs, hardware
  compatibility list). "Easy Bugs List" for newcomers.
- **Controller mappings** contributed via GitHub (XML + JS), flowing Certified → Community Supported.
- **Translations** via Transifex. **Funding** via donations.

## 7. What this means for internal-dj (product positioning)

We are cloning a mature, full-featured DJ app. Realistic phasing (detail in `07`):

1. **Core MVP**: 2–4 decks, waveforms, play/cue/hotcues, tempo + keylock, 3-band EQ + crossfader,
   manual beatmatch + sync, beatloops, a basic library with BPM/key analysis, recording.
2. **Pro**: effects framework, Auto DJ, sampler decks, broadcasting, MIDI/HID controller support
   (reusing Mixxx's `engine`/`midi` JS contract to inherit existing mappings), library importers.
3. **Differentiators** (where Electron/web helps): inbound streaming service integration, modern
   touch-friendly UI, cloud library sync, in-browser distribution. Plus our existing stem/karaoke
   work (`../loukai`, `../stem-mp4`) aligns with 2.6's stem feature.
