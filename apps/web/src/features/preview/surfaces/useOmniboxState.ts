import { type RefObject, useCallback, useRef, useState } from "react";

/** Values from the preview session used to derive smart omnibox display state. */
export interface UseOmniboxStateOptions {
  /** Current URL from last navigation. */
  url: string;
  /** Page title from last navigation. */
  pageTitle: string | null;
  /** Favicon URL from page-favicon-updated. */
  faviconUrl: string | null;
}

/** Derived smart omnibox UI state plus input event handlers for `BrowserHeader`. */
export interface OmniboxState {
  /** Value to display in the input. */
  displayValue: string;
  /** Whether the favicon should be visible. */
  showFavicon: boolean;
  /** Whether the input is displaying the page title (controls font weight, cursor). */
  showAsTitle: boolean;
  /** Ref to attach to the input element for programmatic select(). */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Placeholder text for the input. */
  placeholder: string;
  /** Call on input focus. */
  onFocus: () => void;
  /** Call on input blur. */
  onBlur: () => void;
  /** Call on input value change. */
  onChange: (value: string) => void;
  /** Call on form submit (Enter or Go button). Returns the URL to navigate to. */
  onSubmit: () => string;
}

/**
 * State machine for the smart omnibox.
 *
 * Blurred + clean: shows page title (or URL if no title).
 * Blurred + dirty: shows the user's draft URL.
 * Focused: shows the editable URL with text selected.
 *
 * Dirty state clears when the synced `url` prop changes after navigation - not at submit -
 * so a failed or ignored navigate keeps the typed draft visible.
 */
export function useOmniboxState({
  url,
  pageTitle,
  faviconUrl,
}: UseOmniboxStateOptions): OmniboxState {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [draft, setDraft] = useState(() => ({
    sourceUrl: url,
    value: url,
    dirty: false,
  }));
  const activeDraft = draft.sourceUrl === url
    ? draft
    : { sourceUrl: url, value: url, dirty: false };
  const { value: draftUrl, dirty: isDirty } = activeDraft;

  const onFocus = useCallback(() => {
    setIsFocused(true);
    // Populate draft from current URL (not the stale draft).
    if (!isDirty) {
      setDraft((current) => {
        if (
          current.sourceUrl === url &&
          current.value === url &&
          !current.dirty
        ) {
          return current;
        }
        return { sourceUrl: url, value: url, dirty: false };
      });
    }
    // Select all text after React re-renders with the URL value.
    requestAnimationFrame(() => {
      inputRef.current?.select();
    });
  }, [url, isDirty]);

  const onBlur = useCallback(() => {
    setIsFocused(false);
  }, []);

  const onChange = useCallback((value: string) => {
    setDraft({ sourceUrl: url, value, dirty: true });
  }, [url]);

  const onSubmit = useCallback((): string => {
    return draftUrl;
  }, [draftUrl]);

  // Derive display value.
  let displayValue: string;
  if (isFocused) {
    displayValue = draftUrl;
  } else if (isDirty) {
    displayValue = draftUrl;
  } else if (pageTitle) {
    displayValue = pageTitle;
  } else {
    displayValue = url;
  }

  const showFavicon = !isFocused && !isDirty && !!pageTitle && !!faviconUrl;
  const showAsTitle = !isFocused && !isDirty && !!pageTitle;
  const placeholder = "Search or enter URL";

  return {
    displayValue,
    showFavicon,
    showAsTitle,
    inputRef,
    placeholder,
    onFocus,
    onBlur,
    onChange,
    onSubmit,
  };
}
