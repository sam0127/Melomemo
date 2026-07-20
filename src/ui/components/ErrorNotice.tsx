import type { AppError } from '../../core/result.ts';
import { describeError } from '../errorMessages.ts';

interface ErrorNoticeProps {
  error: AppError;
  onDismiss: () => void;
}

export function ErrorNotice({ error, onDismiss }: ErrorNoticeProps) {
  const { title, detail } = describeError(error);
  return (
    // role="alert" rather than the polite region: these interrupt a task the
    // user is in the middle of, and waiting for a pause would be too late.
    <div className="notice notice--error" role="alert">
      <div className="notice__body">
        <strong className="notice__title">{title}</strong>
        <p className="notice__detail">{detail}</p>
      </div>
      <button
        type="button"
        className="button notice__dismiss"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}
