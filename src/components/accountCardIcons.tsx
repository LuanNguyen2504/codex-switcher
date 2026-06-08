/**
 * Icon helpers used by the account card action row.
 *
 * Purpose:
 *   Provides compact SVG icons and shared sizing classes for account metadata and action buttons.
 * Inputs:
 *   This module has no runtime inputs; each exported component accepts no props.
 * Output:
 *   Exports React SVG components and a shared class helper for icon-only buttons.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */

/**
 * Renders the shared clock icon used by compact metadata buttons.
 *
 * Purpose:
 *   Shows quota refresh timing without text inside the account card.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG clock icon.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
export function ClockIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

/**
 * Renders the shared calendar icon used for subscription expiry metadata.
 *
 * Purpose:
 *   Shows subscription expiry status without occupying horizontal space with text.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG calendar icon.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
export function CalendarIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 2v4M16 2v4M3 10h18" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
    </svg>
  );
}

/**
 * Renders the shared active-account check icon.
 *
 * Purpose:
 *   Marks the current active account in an icon-only action row.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG check icon.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
export function CheckIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

/**
 * Renders the shared account-switch icon.
 *
 * Purpose:
 *   Represents manual switching to the selected account.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG arrow-switch icon.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
export function SwitchIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h10l-3-3M17 17H7l3 3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 7L7 17" />
    </svg>
  );
}

/**
 * Renders the shared running-process indicator icon.
 *
 * Purpose:
 *   Indicates manual switching is blocked because Codex is currently running.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG activity icon.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
export function RunningIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 13h4l2-6 4 12 2-6h4" />
    </svg>
  );
}

/**
 * Renders the shared loading spinner icon.
 *
 * Purpose:
 *   Shows a pending operation, such as switching or refreshing, in icon-only controls.
 * Inputs:
 *   None.
 * Output:
 *   Returns an animated SVG spinner icon.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
export function SpinnerIcon() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M21 12a9 9 0 00-9-9v3a6 6 0 016 6h3z" />
    </svg>
  );
}

/**
 * Renders the shared warm-up icon.
 *
 * Purpose:
 *   Represents manual or automatic warm-up state in compact account controls.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG lightning icon.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
export function WarmupIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}

/**
 * Renders the shared waiting icon for weekly quota reset.
 *
 * Purpose:
 *   Shows that auto warm-up is enabled but blocked until the weekly quota resets.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG hourglass icon.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
export function HourglassIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 2h12M6 22h12M8 2v5a4 4 0 002 3l2 2 2-2a4 4 0 002-3V2M16 22v-5a4 4 0 00-2-3l-2-2-2 2a4 4 0 00-2 3v5" />
    </svg>
  );
}

/**
 * Renders the shared refresh icon.
 *
 * Purpose:
 *   Represents manual quota reload in compact account controls.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG refresh icon.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
export function RefreshIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 11a8 8 0 10-2.34 5.66" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 5v6h-6" />
    </svg>
  );
}

/**
 * Renders the shared delete icon.
 *
 * Purpose:
 *   Represents account removal in compact account controls.
 * Inputs:
 *   None.
 * Output:
 *   Returns an SVG close icon.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
export function DeleteIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * Returns the shared square icon-button base classes.
 *
 * Purpose:
 *   Keeps icon-only metadata and action controls visually consistent across account cards.
 * Inputs:
 *   None.
 * Output:
 *   Returns a Tailwind class string with stable dimensions and center alignment.
 * Errors:
 *   Does not throw intentionally.
 * Side Effects:
 *   None.
 */
export function iconButtonBaseClass(): string {
  return "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors";
}
