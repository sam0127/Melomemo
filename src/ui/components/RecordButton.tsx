import { MAX_RECORDING_MS, type RecordingState } from '../../capture/RecordingService.ts';
import { formatDuration } from '../../core/format.ts';

interface RecordButtonProps {
  state: RecordingState;
  elapsedMs: number;
  remainingMs: number;
  onStart: () => void;
  onStop: () => void;
}

export function RecordButton({
  state,
  elapsedMs,
  remainingMs,
  onStart,
  onStop,
}: RecordButtonProps) {
  const recording = state === 'recording';
  const busy = state === 'preparing' || state === 'finalizing';

  const label = recording
    ? 'Stop recording'
    : busy
      ? state === 'preparing'
        ? 'Starting…'
        : 'Saving…'
      : 'New recording';

  return (
    <div className="recorder">
      <button
        type="button"
        className="record-button"
        data-recording={recording || undefined}
        // The accessible name changes with state rather than relying on the
        // icon, so the control announces what pressing it will do.
        aria-label={label}
        disabled={busy}
        onClick={recording ? onStop : onStart}
      >
        <span className="record-button__glyph" aria-hidden="true" />
        <span className="record-button__text">{label}</span>
      </button>

      {recording && (
        <div className="recorder__status">
          {/*
            role="timer" carries an implicit aria-live of "off". That is the
            point: a counter that announced every tick would bury every other
            message, so the running time stays readable on demand while start
            and stop are announced through the app's live region.
          */}
          <p className="recorder__timer" role="timer">
            {formatDuration(elapsedMs)}
            <span className="recorder__limit"> / {formatDuration(MAX_RECORDING_MS)}</span>
          </p>
          {remainingMs <= 15_000 && (
            <p className="recorder__warning">
              {formatDuration(remainingMs)} left
            </p>
          )}
        </div>
      )}
    </div>
  );
}
