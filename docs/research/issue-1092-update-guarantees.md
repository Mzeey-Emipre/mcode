# Update guarantees for shipped desktop packages

Issue: [Research update guarantees for every shipped package](https://github.com/Mzeey-Empire/mcode/issues/1092)

## Result

No current Mcode package or credible replacement provides all parts of the required guarantee by itself:

- an update that cannot leave a partial installation;
- automatic recovery after candidate health fails; and
- an independently launchable last-known-good application until candidate health succeeds.

The cross-platform guarantee therefore needs a Mcode-owned recovery layer. It must keep versioned application payloads, run outside the candidate process, switch a durable active-version pointer, and retain the prior payload until bounded health checks pass. Package-specific tools can remain below that layer, but they cannot own the guarantee.

This final architecture statement is an inference from the source-backed limits below. None of the cited mechanisms documents the complete guarantee.

## Current Mcode baseline

Mcode 0.13.0 uses `electron-updater` 6.8.3. It builds Windows NSIS and ZIP artifacts, macOS DMG and ZIP artifacts, and Linux AppImage and DEB artifacts. The application checks GitHub Releases, downloads through `electron-updater`, and calls `quitAndInstall()` after it stops the local server.

The upstream support matrix lists NSIS, macOS DMG with a ZIP update payload, AppImage, and DEB as auto-updatable targets. It does not list Windows ZIP as an auto-updatable target. macOS code signing is required. The updater also validates Windows code signatures. See [electron-builder Auto Update](https://www.electron.build/docs/features/auto-update/).

The repository contains no retained application slot, external recovery launcher, candidate health transaction, or post-install rollback path. This statement describes the inspected Mcode code. It is not an upstream guarantee.

## Package matrix

| Shipped package | Current or credible mechanism | Source-backed behavior | Independently launchable last-known-good version |
| --- | --- | --- | --- |
| Windows NSIS | `electron-updater` and NSIS | NSIS is the supported Windows target. Current upstream documentation states that the detached installer can leave a partial installation if it is interrupted. The newer install-on-next-launch mode reduces shutdown races but does not make installation atomic. See [electron-builder install on next launch](https://www.electron.build/docs/features/auto-update/#install-on-next-launch-windowslinux). | No documented guarantee. NSIS updates one installed application tree. Mcode must keep another signed payload or application slot. |
| Windows ZIP | Manual extraction or a custom helper | ZIP is a distribution target, not an `electron-updater` Windows update target. The archive supplies no activation or rollback transaction. See [electron-builder target selection](https://www.electron.build/docs/targets/) and [auto-updatable targets](https://www.electron.build/docs/features/auto-update/#auto-updatable-targets). | Only if a custom helper keeps versioned directories and switches launch ownership. |
| macOS DMG and ZIP | `electron-updater` with Squirrel.Mac | DMG is the shipped distribution artifact. ZIP is required as the Squirrel.Mac update payload. Upstream describes a staged, atomic application-bundle swap on relaunch. Code signing is required. See [electron-builder Auto Update](https://www.electron.build/docs/features/auto-update/). | No documented old-bundle retention or automatic rollback after a bad first launch. Atomic replacement prevents partial writes, but it does not preserve a second launch target. |
| Linux AppImage | `electron-updater` or AppImageUpdate | AppImage is an `electron-updater` target, and electron-builder embeds blockmap data for differential downloads. AppImageUpdate uses embedded update information and zsync deltas. The sources do not promise transactional replacement or rollback. See [electron-builder AppImage](https://www.electron.build/appimage/), [AppImageKit](https://github.com/AppImage/AppImageKit), and [appimage-builder updates](https://appimage-builder.readthedocs.io/en/latest/advanced/updates.html). | Only if Mcode retains the old AppImage under a versioned name and switches an external launcher or link after validation. |
| Linux DEB | `electron-updater` plus `dpkg` or APT | DEB installation requires package-manager authority. Debian Policy documents failure recovery before a point of no return, but later failures can leave a package half-installed and require reinstallation. See [Debian Policy maintainer scripts](https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html). | No. Package-state recovery does not retain an independently launchable old application. Mcode must retain the old package or a separate recovery payload. |

## Credible alternatives

### Windows MSIX and App Installer

Windows App Installer supports checks at launch or in the background, delayed application, activation blocking, repair sources, and signed package trust. Windows also supports downgrade when `ForceUpdateFromAnyVersion` applies. See [Microsoft auto-update and repair](https://learn.microsoft.com/en-us/windows/msix/app-installer/auto-update-and-repair--overview) and [MSIX deployment planning](https://learn.microsoft.com/en-us/windows/msix/desktop/managing-your-msix-deployment-targetdevices).

Microsoft states that downgrade preserves application data, but it does not undo changes that the newer application made to that data. See [install an earlier MSIX version](https://learn.microsoft.com/en-us/windows/msix/desktop/managing-your-msix-deployment-downgrading).

MSIX supplies the strongest Windows-owned deployment boundary in this review. It does not keep the old package concurrently launchable. Recovery requires a retained signed package and another deployment operation. It also changes Mcode's packaging and installation model, so it is not a drop-in replacement for the shipped NSIS and ZIP formats.

### Squirrel.Windows

Squirrel.Windows documents per-user, no-UAC installation, background updates, versioned application directories, and delta packages. See the [Squirrel.Windows repository](https://github.com/Squirrel/Squirrel.Windows).

Its public documentation does not promise retention of a previous version for Mcode's health window or automatic rollback after first-launch failure. `electron-builder` also states that its simplified updater does not support Squirrel.Windows. A Squirrel design would still need an explicit retention and launcher policy.

### Sparkle on macOS

Sparkle documents Ed25519 signatures, Apple code-signature validation, delta updates, permission handling, and atomic-safe installation. See the [Sparkle repository](https://github.com/sparkle-project/Sparkle) and [Sparkle documentation](https://sparkle-project.org/documentation/).

Sparkle does not document a concurrently launchable prior bundle or automatic rollback after application health fails. It can improve download and replacement safety, but Mcode still needs an old-bundle retention and recovery policy.

## Failure boundaries

The update design must treat these boundaries separately:

1. **Discovery and download:** Network failure must leave the active application unchanged. Signed metadata and artifact verification must finish before activation.
2. **Installation:** NSIS, AppImage replacement, and DEB installation do not provide the required atomic recovery guarantee. Squirrel.Mac and Sparkle improve atomic replacement but do not retain the prior launch target.
3. **First launch:** None of the reviewed package tools applies Mcode's required health checks for the desktop process, UI, server, database, and IPC.
4. **Data migration:** Package rollback does not roll back user data. Microsoft explicitly warns that MSIX downgrade keeps changes from the newer application. Mcode needs its own data compatibility transaction.
5. **Recovery:** The recovery component must run independently of the candidate. A candidate cannot reliably recover itself when it does not start.

## Constraints for the next decision

- Preserve GitHub Releases as the artifact source unless later control-plane research rejects it.
- Keep the pre-update application payload and compatible data until candidate health succeeds.
- Put activation and recovery outside the candidate process.
- Use one cross-platform transaction model with package-specific adapters.
- Treat package-manager repair or downgrade as guided repair, not as the sole last-known-good mechanism.
- Do not equate differential download, atomic file replacement, or package-manager rollback with candidate health validation.

## Open evidence gaps

- Test the exact interruption behavior of Mcode's pinned `electron-updater` 6.8.3 and installer versions. Current upstream documentation includes behavior added after those versions.
- Verify whether the final Linux DEB design may install a small independent recovery component outside the package-owned application path.
- Verify macOS signing and notarization rules for two retained, independently launchable application bundles with one product identity.
- Verify Windows shortcut and registration behavior when an external launcher owns version selection for NSIS and ZIP installs.
