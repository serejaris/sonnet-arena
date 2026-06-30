/**
 * M3 HUD: plain-DOM overlay elements layered on top of the WebGL canvas —
 * crosshair, hp readout, hit-marker flash, kill feed, and the death/respawn
 * overlay. Every element already exists in index.html; this class only
 * toggles their state. Deliberately no Three.js dependency — this is
 * screen-space UI, not scene content (mirrors the existing `#overlay`
 * click-to-play pattern in main.ts/index.html).
 */

const HIT_MARKER_VISIBLE_MS = 150;
const KILL_FEED_VISIBLE_MS = 4000;
const KILL_FEED_FADE_MS = 600;
const KILL_FEED_MAX_ENTRIES = 5;

export class Hud {
  private readonly crosshair = document.getElementById("crosshair");
  private readonly hpDisplay = document.getElementById("hp-display");
  private readonly hitMarker = document.getElementById("hit-marker");
  private readonly killFeed = document.getElementById("kill-feed");
  private readonly deathOverlay = document.getElementById("death-overlay");

  private hitMarkerTimeout: ReturnType<typeof setTimeout> | null = null;

  setCrosshairVisible(visible: boolean): void {
    this.crosshair?.classList.toggle("visible", visible);
  }

  setHp(hp: number): void {
    if (!this.hpDisplay) return;
    this.hpDisplay.textContent = `HP ${Math.max(0, Math.round(hp))}`;
  }

  /** Brief on-screen flash confirming a shot THIS client fired registered on the server. */
  showHitMarker(): void {
    if (!this.hitMarker) return;
    this.hitMarker.classList.add("show");
    if (this.hitMarkerTimeout) clearTimeout(this.hitMarkerTimeout);
    this.hitMarkerTimeout = setTimeout(
      () => this.hitMarker?.classList.remove("show"),
      HIT_MARKER_VISIBLE_MS,
    );
  }

  /** Newest entry appears on top; older entries fade out and get removed automatically. */
  addKillFeedEntry(killerName: string, victimName: string): void {
    if (!this.killFeed) return;

    const entry = document.createElement("div");
    entry.className = "kill-feed-entry";
    entry.textContent = `${killerName} eliminated ${victimName}`;
    this.killFeed.prepend(entry);

    while (this.killFeed.children.length > KILL_FEED_MAX_ENTRIES) {
      const oldest = this.killFeed.lastElementChild;
      if (!oldest) break;
      this.killFeed.removeChild(oldest);
    }

    setTimeout(() => {
      entry.classList.add("fade");
      setTimeout(() => entry.remove(), KILL_FEED_FADE_MS);
    }, KILL_FEED_VISIBLE_MS);
  }

  showDeathOverlay(): void {
    this.deathOverlay?.classList.remove("hidden");
  }

  hideDeathOverlay(): void {
    this.deathOverlay?.classList.add("hidden");
  }
}
