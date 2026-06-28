import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ControlBus,
  standardControls,
  deck as deckGroup,
  LIBRARY,
  PLAYLIST,
  LibraryKeys,
} from '@dj/control-bus';
import { LibraryControl } from './library-control.js';

// Controller library navigation + loading. 121 mappings need LoadSelectedTrack; this is
// the gate to using a controller. Verifies nav moves the selection and load fires the
// right deck — including the real-mapping path where LoadSelectedTrack is driven on the
// DECK group ([ChannelN]) to mean "load into deck N".

function setup() {
  const bus = new ControlBus();
  for (const c of standardControls(2)) bus.define(c);
  const loads: Array<{ i: number; deck: number; play: boolean }> = [];
  const activated: number[] = [];
  const ctl = new LibraryControl({
    bus,
    numDecks: 2,
    trackCount: () => 10,
    firstStoppedDeck: () => 0,
    loadIndexToDeck: (i, deck, play) => loads.push({ i, deck, play }),
    sidebarCount: () => 4, // All Tracks + 3 playlists
    activateSidebar: (i) => activated.push(i),
  });
  return {
    bus,
    ctl,
    loads,
    activated,
    sel: () => bus.get(LIBRARY, LibraryKeys.selectedIndex),
    focus: () => bus.get(LIBRARY, LibraryKeys.focusArea),
    plIdx: () => bus.get(LIBRARY, LibraryKeys.playlistIndex),
  };
}

describe('LibraryControl', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('SelectNextTrack / SelectPrevTrack move the selection by 1 and self-reset', () => {
    s.bus.set(LIBRARY, LibraryKeys.selectNextTrack, 1);
    expect(s.sel()).toBe(1);
    expect(s.bus.get(LIBRARY, LibraryKeys.selectNextTrack)).toBe(0); // pulse reset
    s.bus.set(LIBRARY, LibraryKeys.selectNextTrack, 1);
    expect(s.sel()).toBe(2);
    s.bus.set(LIBRARY, LibraryKeys.selectPrevTrack, 1);
    expect(s.sel()).toBe(1);
  });

  it('SelectTrackKnob moves by a signed delta', () => {
    s.bus.set(LIBRARY, LibraryKeys.selectTrackKnob, 3);
    expect(s.sel()).toBe(3);
    s.bus.set(LIBRARY, LibraryKeys.selectTrackKnob, 127); // two's-complement -1
    expect(s.sel()).toBe(2);
  });

  it('clamps selection to [0, count-1]', () => {
    s.bus.set(LIBRARY, LibraryKeys.selectPrevTrack, 1); // already at 0
    expect(s.sel()).toBe(0);
    s.bus.set(LIBRARY, LibraryKeys.selectTrackKnob, 999); // past the end
    expect(s.sel()).toBe(9);
  });

  it('[Playlist] group navigates the same selection (old mappings use it)', () => {
    s.bus.set(PLAYLIST, LibraryKeys.selectNextTrack, 1);
    expect(s.bus.get(PLAYLIST, LibraryKeys.selectedIndex)).toBe(1);
    expect(s.sel()).toBe(1); // both groups in lockstep
  });

  it('LoadSelectedTrack on [Library] loads the selection into the first stopped deck', () => {
    s.bus.set(LIBRARY, LibraryKeys.selectTrackKnob, 4);
    s.bus.set(LIBRARY, LibraryKeys.loadSelectedTrack, 1);
    expect(s.loads).toEqual([{ i: 4, deck: 0, play: false }]);
  });

  it('LoadSelectedTrack on a DECK group loads into THAT deck (real-mapping path)', () => {
    s.bus.set(LIBRARY, LibraryKeys.selectTrackKnob, 2);
    // DJ2GO2-style: load button drives [Channel2].LoadSelectedTrack → deck index 1
    s.bus.set(deckGroup(2), LibraryKeys.loadSelectedTrack, 1);
    expect(s.loads).toEqual([{ i: 2, deck: 1, play: false }]);
  });

  it('LoadSelectedTrackAndPlay requests play', () => {
    s.bus.set(deckGroup(1), LibraryKeys.loadSelectedTrackAndPlay, 1);
    expect(s.loads.at(-1)).toMatchObject({ deck: 0, play: true });
  });

  it('dispose() stops reacting', () => {
    s.ctl.dispose();
    s.bus.set(LIBRARY, LibraryKeys.selectNextTrack, 1);
    expect(s.sel()).toBe(0);
  });

  describe('focus navigation (playlist sidebar <-> song list)', () => {
    it('GoToItem from songs moves focus UP to the sidebar', () => {
      expect(s.focus()).toBe(0); // start in songs
      s.bus.set(LIBRARY, LibraryKeys.goToItem, 1);
      expect(s.focus()).toBe(1); // now in the sidebar
    });

    it('in the sidebar, scroll moves the playlist cursor (not the song selection)', () => {
      s.bus.set(LIBRARY, LibraryKeys.goToItem, 1); // focus sidebar
      s.bus.set(LIBRARY, LibraryKeys.moveDown, 1);
      expect(s.plIdx()).toBe(1);
      expect(s.sel()).toBe(0); // song selection untouched
      s.bus.set(LIBRARY, LibraryKeys.moveDown, 1);
      expect(s.plIdx()).toBe(2);
    });

    it('GoToItem from the sidebar activates the highlighted playlist + drops back to songs', () => {
      s.bus.set(LIBRARY, LibraryKeys.goToItem, 1); // → sidebar
      s.bus.set(LIBRARY, LibraryKeys.moveDown, 1); // highlight row 1 (first playlist)
      s.bus.set(LIBRARY, LibraryKeys.goToItem, 1); // select + descend
      expect(s.activated.at(-1)).toBe(1); // activated sidebar row 1
      expect(s.focus()).toBe(0); // back in the song list
    });

    it('SelectNextPlaylist focuses the sidebar and advances it', () => {
      s.bus.set(LIBRARY, LibraryKeys.selectNextPlaylist, 1);
      expect(s.focus()).toBe(1);
      expect(s.plIdx()).toBe(1);
    });
  });
});
