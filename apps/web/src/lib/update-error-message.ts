/** Human-readable title and body for a failed update, ready for a toast. */
export interface FriendlyUpdateError {
  /** Short sentence-case headline, no trailing period. */
  readonly title: string;
  /** One-sentence explanation with a recovery hint. */
  readonly body: string;
}

/**
 * Translate a raw `electron-updater` error message into friendly copy.
 *
 * Transient connectivity blips are already filtered in the main process, so the
 * messages that reach here are genuine failures (or a connectivity error during
 * a manual download, which bypasses that filter). The raw text is
 * developer-facing (`HttpError: 404`, `net::ERR_NAME_NOT_RESOLVED`, signature
 * traces); this maps the few categories a user can act on to plain language and
 * falls back to a safe generic message for everything else.
 */
export function friendlyUpdateError(raw: string | undefined): FriendlyUpdateError {
  const message = (raw ?? "").toLowerCase();

  if (/signature|verif|checksum|sha512|integrity/.test(message)) {
    return {
      title: "Update couldn't be verified",
      body: "The downloaded update failed a security check. Reinstall Mcode from the official source.",
    };
  }

  if (/enospc|no space|not enough space|disk full/.test(message)) {
    return {
      title: "Not enough disk space",
      body: "There isn't enough space to download the update. Free up some space and try again.",
    };
  }

  if (/403|forbidden|denied|unauthor/.test(message)) {
    return {
      title: "Update access was denied",
      body: "Mcode couldn't reach the update server. Try again in a little while.",
    };
  }

  if (/404|cannot find|latest\.yml|no (such )?(file|asset)|not found/.test(message)) {
    return {
      title: "No update package found",
      body: "The update files aren't ready yet. Try again later.",
    };
  }

  if (/net::|enotfound|econnrefused|econnreset|etimedout|timeout|gateway|offline|disconnected/.test(message)) {
    return {
      title: "Couldn't reach the update server",
      body: "Check your internet connection and try again.",
    };
  }

  return {
    title: "Update failed",
    body: "Something went wrong while updating. Try again later.",
  };
}
