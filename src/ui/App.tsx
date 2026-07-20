import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDurationSpoken } from '../core/format.ts';
import type { AppError } from '../core/result.ts';
import type { CapturedAudio, Memo } from '../core/types.ts';
import { PlaybackService } from '../playback/PlaybackService.ts';
import { TonePlayer, type TonePlayerState } from '../playback/TonePlayer.ts';
import type { NotePlaybackControls } from './notePlayback.ts';
import { exportArchive, exportAudio, importArchive } from '../storage/archive.ts';
import { IdbMemoRepository } from '../storage/memoRepository.ts';
import { probeStorageWritable } from '../storage/persistence.ts';
import { ErrorNotice } from './components/ErrorNotice.tsx';
import { MemoList } from './components/MemoList.tsx';
import { NowPlaying } from './components/NowPlaying.tsx';
import { RecordButton } from './components/RecordButton.tsx';
import {
  IosStorageSplitNotice,
  StorageBanner,
} from './components/StorageBanner.tsx';
import { useAnnouncer } from './hooks/useAnnouncer.ts';
import { useMemos } from './hooks/useMemos.ts';
import { useRecorder } from './hooks/useRecorder.ts';
import { useServiceWorkerUpdate } from './hooks/useServiceWorkerUpdate.ts';
import { useTranscription } from './hooks/useTranscription.ts';

export function App() {
  // Constructed once and shared for the app's lifetime. Neither owns React
  // state, so neither belongs in a hook.
  const repository = useMemo(() => new IdbMemoRepository(), []);
  const playback = useMemo(() => new PlaybackService(), []);
  const tonePlayer = useMemo(() => new TonePlayer(), []);

  const audioRef = useRef<HTMLAudioElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  /** Whether a scrub interrupted playback that should resume when it ends. */
  const scrubResumeRef = useRef(false);

  const { message, announce } = useAnnouncer();
  const [notice, setNotice] = useState<string | null>(null);
  const [uiError, setUiError] = useState<AppError | null>(null);
  const [storageWritable, setStorageWritable] = useState(true);
  const [currentMemoId, setCurrentMemoId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [noteTransport, setNoteTransport] = useState<TonePlayerState>({
    status: 'idle',
    memoId: null,
  });

  const memosApi = useMemos(repository);
  const { memos, loading, saveCaptured, remove, rename } = memosApi;

  // Hand the rendered <audio> to the playback service once it exists.
  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    const detach = playback.attach(element);
    const unsubscribe = playback.subscribe((state) => {
      setCurrentMemoId(state.memoId);
      setIsPlaying(state.playing);
    });
    return () => {
      unsubscribe();
      detach();
    };
  }, [playback]);

  useEffect(() => () => playback.dispose(), [playback]);

  // The player is authoritative; this only mirrors it for rendering. Nothing
  // else writes noteTransport, so the controls cannot disagree with what is
  // actually sounding — including when a sequence ends on its own.
  useEffect(
    () => tonePlayer.subscribe(setNoteTransport),
    [tonePlayer],
  );

  useEffect(() => () => tonePlayer.dispose(), [tonePlayer]);

  // Private Browsing exposes IndexedDB but rejects writes, so the app has to
  // probe rather than feature-detect, and say so before a take is lost.
  useEffect(() => {
    void probeStorageWritable().then(setStorageWritable);
  }, []);

  const transcription = useTranscription(repository, memosApi.reload);

  const handleCaptured = useCallback(
    async (captured: CapturedAudio) => {
      const memo = await saveCaptured(captured);
      if (!memo) return;
      announce(`Memo saved, ${formatDurationSpoken(memo.capture.durationMs)}.`);
      // Not awaited: the memo is already saved and listed, and transcription
      // is a slower, less reliable stage that must not gate seeing it.
      void transcription.transcribe(memo);
    },
    [saveCaptured, announce, transcription],
  );

  const recorder = useRecorder({
    onCaptured: handleCaptured,
    onFlush: (session) => void repository.saveScratch(session),
    onNotice: setNotice,
  });

  const handleStart = useCallback(async () => {
    setNotice(null);
    // Playback and capture competing for the audio session goes badly on iOS.
    playback.reset();
    tonePlayer.stop();
    // Only announce success. The failure path already surfaces an alert, and
    // telling a screen-reader user that recording began when it did not is
    // worse than saying nothing.
    if (await recorder.start()) announce('Recording started.');
  }, [playback, tonePlayer, recorder, announce]);

  const handleStop = useCallback(() => {
    recorder.stop();
    announce('Recording stopped, saving.');
  }, [recorder, announce]);

  const handleTogglePlay = useCallback(
    async (memo: Memo) => {
      if (currentMemoId === memo.id && isPlaying) {
        playback.pause();
        return;
      }
      const audio = await repository.getAudio(memo.id);
      if (!audio.ok) {
        setUiError(audio.error);
        return;
      }
      // Same exclusion in the other direction: starting the recording stops
      // any transcription that is playing.
      tonePlayer.stop();
      await playback.play(memo.id, audio.value.data, audio.value.mimeType);
    },
    [currentMemoId, isPlaying, playback, repository, tonePlayer],
  );

  const handleDelete = useCallback(
    async (memo: Memo) => {
      playback.stopIfPlaying(memo.id);
      await remove(memo.id);
      announce(`Deleted ${memo.title}.`);
    },
    [playback, remove, announce],
  );

  const notePlayback: NotePlaybackControls = useMemo(
    () => ({
      statusFor: (memoId) =>
        noteTransport.memoId === memoId ? noteTransport.status : 'idle',

      toggle: (memo, notes) => {
        // Read transport state from the player rather than from render state,
        // so a rapid toggle cannot act on a value that has already moved on.
        if (tonePlayer.currentMemoId === memo.id) {
          if (tonePlayer.status === 'playing') {
            tonePlayer.pause();
            return;
          }
          if (tonePlayer.status === 'paused') {
            playback.pause();
            void tonePlayer.resume();
            return;
          }
        }
        // The recording and its transcription played at once are just noise,
        // and on iOS two sources competing for the audio session goes badly.
        playback.pause();
        void tonePlayer.play(memo.id, [...notes]);
      },

      stop: () => tonePlayer.stop(),

      beginScrub: (memo, notes) => {
        if (tonePlayer.currentMemoId !== memo.id) {
          // Scrubbing a different memo's playhead takes the transport over.
          tonePlayer.load(memo.id, [...notes]);
          scrubResumeRef.current = false;
          return;
        }
        // Remembered so the scrub can put playback back as it found it.
        scrubResumeRef.current = tonePlayer.status === 'playing';
        if (scrubResumeRef.current) tonePlayer.pause();
      },

      endScrub: (memo, notes, ms) => {
        if (tonePlayer.currentMemoId !== memo.id) {
          tonePlayer.load(memo.id, [...notes]);
        }
        tonePlayer.seek(ms);
        if (scrubResumeRef.current) {
          scrubResumeRef.current = false;
          playback.pause();
          void tonePlayer.resume();
        }
      },

      positionMs: () => tonePlayer.positionMs,
    }),
    [noteTransport, playback, tonePlayer],
  );

  const handleTranscribe = useCallback(
    async (memo: Memo) => {
      announce(`Transcribing ${memo.title}.`);
      await transcription.transcribe(memo);
    },
    [transcription, announce],
  );

  const handleRename = useCallback(
    async (memo: Memo, title: string) => {
      await rename(memo.id, title);
      // The row's own text changed silently; without this a screen-reader user
      // gets no confirmation the edit took.
      announce(`Renamed to ${title}.`);
    },
    [rename, announce],
  );

  const handleExportOne = useCallback(
    async (memo: Memo) => {
      const result = await exportAudio(repository, memo);
      if (!result.ok) setUiError(result.error);
      else announce(`Exported ${memo.title}.`);
    },
    [repository, announce],
  );

  const handleExportAll = useCallback(async () => {
    const result = await exportArchive(repository);
    if (!result.ok) setUiError(result.error);
    else announce(`Backed up ${result.value} memos.`);
  }, [repository, announce]);

  const handleImportFile = useCallback(
    async (file: File) => {
      const result = await importArchive(repository, file);
      if (!result.ok) {
        setUiError(result.error);
        return;
      }
      await memosApi.reload();
      const { imported, skipped } = result.value;
      announce(
        `Restored ${imported} memo${imported === 1 ? '' : 's'}` +
          (skipped > 0 ? `, skipped ${skipped} already present.` : '.'),
      );
    },
    [repository, memosApi, announce],
  );

  const swUpdate = useServiceWorkerUpdate();
  // Applying an update reloads the page. Offering that mid-recording invites
  // the user to destroy a take in progress, so the prompt waits.
  const canOfferUpdate = swUpdate.needRefresh && recorder.state === 'idle';

  const currentMemo = memos.find((memo) => memo.id === currentMemoId) ?? null;
  const activeError = uiError ?? recorder.error ?? memosApi.error;
  const dismissError = () => {
    setUiError(null);
    recorder.clearError();
    memosApi.clearError();
  };

  return (
    <>
      <a className="skip-link" href="#memos">
        Skip to your memos
      </a>

      <header className="app-header">
        <h1>Melomemo</h1>
        <p className="app-header__tagline">
          Hum it now, work it out later.
        </p>
      </header>

      <main className="app-main">
        <section aria-labelledby="record-heading">
          <h2 id="record-heading" className="visually-hidden">
            Record
          </h2>
          <RecordButton
            state={recorder.state}
            elapsedMs={recorder.elapsedMs}
            remainingMs={recorder.remainingMs}
            onStart={handleStart}
            onStop={handleStop}
          />
        </section>

        {canOfferUpdate && (
          <div className="notice" role="status">
            <div className="notice__body">
              <strong className="notice__title">An update is ready</strong>
              <p className="notice__detail">
                Reloading applies it. Your saved memos are unaffected.
              </p>
            </div>
            <button type="button" className="button" onClick={swUpdate.applyUpdate}>
              Reload
            </button>
            <button type="button" className="button" onClick={swUpdate.dismiss}>
              Later
            </button>
          </div>
        )}

        {!storageWritable && <StorageBanner />}

        {activeError && (
          <ErrorNotice error={activeError} onDismiss={dismissError} />
        )}

        {notice && (
          <div className="notice" role="status">
            <p className="notice__detail">{notice}</p>
            <button
              type="button"
              className="button notice__dismiss"
              onClick={() => setNotice(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        <section id="memos" aria-labelledby="memos-heading">
          <div className="section-header">
            <h2 id="memos-heading">Your memos</h2>
            <div className="section-header__actions">
              <button
                type="button"
                className="button"
                onClick={handleExportAll}
                disabled={memos.length === 0}
              >
                Back up all
              </button>
              <button
                type="button"
                className="button"
                onClick={() => importInputRef.current?.click()}
              >
                Restore
              </button>
              {/*
                A hidden input driven by a real button: the native file input
                is impossible to style consistently, but it must stay in the
                DOM so the picker still works.
              */}
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="visually-hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleImportFile(file);
                  // Reset so choosing the same file twice still fires.
                  event.target.value = '';
                }}
              />
            </div>
          </div>

          {/* An installed iOS app cannot see memos recorded in Safari. */}
          {!loading && memos.length === 0 && <IosStorageSplitNotice />}

          {loading ? (
            <p className="empty-state">Loading…</p>
          ) : (
            <MemoList
              memos={memos}
              currentMemoId={currentMemoId}
              isPlaying={isPlaying}
              repository={repository}
              isTranscribing={transcription.isRunning}
              notePlayback={notePlayback}
              onTogglePlay={handleTogglePlay}
              onTranscribe={handleTranscribe}
              onRename={handleRename}
              onExport={handleExportOne}
              onDelete={handleDelete}
            />
          )}
        </section>
      </main>

      <NowPlaying ref={audioRef} memo={currentMemo} />

      {/*
        One polite region for the whole app. Discrete events only — the
        recording timer deliberately does not route through here.
      */}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {message}
      </div>
    </>
  );
}
