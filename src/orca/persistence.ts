import type { DecorPlacement } from './decor/catalog'

export interface SaveData {
  version: number
  /** Tokens the orca has eaten over the whole life of this save. */
  feedCount: number
  /**
   * Tokens eaten since the last 复原. Growth is derived from this, not from
   * `feedCount`, so resetting the size does not throw away the lifetime tally.
   */
  growthFeeds: number
  lastFeedAt: number
  decor: DecorPlacement[]
  /** Bloom glow strength (0 = off, ~0.45 default — the soft reef halo). */
  bloomStrength: number
  /** Orca skin id (pet.html skin system): classic/night/pink/green/gold. */
  skin: string
  /** Background music. Off by default: unexpected audio is hostile. */
  music: boolean
  /** Whether the clawd companion follows the orca. At most one ever exists. */
  companion: boolean
  /** Times the companion has been poked. */
  companionPets: number
  /**
   * Whether the GPT seal companion follows the orca. Independent of `companion`
   * — the two can swim together, but each is still a single lazily-created
   * object, so neither can ever be duplicated.
   */
  companionSeal: boolean
  /** Times the seal has been poked. */
  companionSealPets: number
  /**
   * Whether the jellyfish companion follows the orca. Independent of the other
   * two — all three can swim together, but each is still a single
   * lazily-created object, so none of them can ever be duplicated.
   */
  companionJelly: boolean
  /** Times the jellyfish has been poked. */
  companionJellyPets: number
  /**
   * Ink outlines on the three characters (orca / Clawd / Seal-GPT), toggled as
   * one from the toolbar. Default off — the flat soft-shaded look is the
   * baseline the art direction settled on; the ink lines are an opt-in style.
   */
  outlines: boolean
  /**
   * 动作速度倍率（0.4~1.8，1 = 原始节奏）。
   *
   * 身体摇摆 / 横滚 / 尾鳍 / 胸鳍 / 体波共用这一个倍率。有人觉得抖得可爱，
   * 有人觉得抽搐，所以交给玩家自己拧。
   */
  motionSpeed: number
}

const STORAGE_KEY = 'orca-aquarium-shell:save:v1'
// Soft glow is part of the scene's look (deepsea reference), so it ships on.
// The decor-panel slider can still zero it, and the choice persists.
const DEFAULT_BLOOM_STRENGTH = 0.45
const SAVE_VERSION = 6
const VALID_SKINS = ['classic', 'night', 'pink', 'green', 'gold']

function defaults(): SaveData {
  return {
    version: SAVE_VERSION,
    feedCount: 0,
    growthFeeds: 0,
    lastFeedAt: 0,
    decor: [],
    bloomStrength: DEFAULT_BLOOM_STRENGTH,
    skin: 'classic',
    music: false,
    companion: false,
    companionPets: 0,
    companionSeal: false,
    companionSealPets: 0,
    companionJelly: false,
    companionJellyPets: 0,
    outlines: false,
    motionSpeed: 1,
  }
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults()
    const parsed = JSON.parse(raw) as Partial<SaveData>
    const version = typeof parsed.version === 'number' ? parsed.version : 1
    const bloomStrength =
      typeof parsed.bloomStrength === 'number' && Number.isFinite(parsed.bloomStrength)
        ? Math.min(1.5, Math.max(0, parsed.bloomStrength))
        : DEFAULT_BLOOM_STRENGTH
    // v3 and earlier counted strokes ("petCount"); the interaction is now
    // feeding, so carry the old tally over rather than throwing it away.
    const feedCount =
      typeof parsed.feedCount === 'number'
        ? parsed.feedCount
        : typeof (parsed as { petCount?: unknown }).petCount === 'number'
          ? ((parsed as { petCount: number }).petCount)
          : 0
    // v5 introduced growth. Every earlier save has a lifetime count and no
    // growth counter, and back then every feed grew the orca, so the lifetime
    // count *is* the right starting value — an existing player reloads into
    // the size they left behind instead of shrinking back to a minnow.
    const growthFeeds =
      typeof parsed.growthFeeds === 'number'
        ? Math.min(feedCount, Math.max(0, parsed.growthFeeds))
        : feedCount
    return {
      version: SAVE_VERSION,
      feedCount,
      growthFeeds,
      lastFeedAt:
        typeof parsed.lastFeedAt === 'number'
          ? parsed.lastFeedAt
          : typeof (parsed as { lastPetAt?: unknown }).lastPetAt === 'number'
            ? ((parsed as { lastPetAt: number }).lastPetAt)
            : 0,
      decor: Array.isArray(parsed.decor) ? parsed.decor.filter(d => d && typeof d.kindId === 'string') : [],
      // v1 saves carry bloomStrength 0 because that was v1's default (the
      // glow did not exist yet). Treat a bare zero as the stale default, not
      // as a deliberate choice, so existing players see the v2 look.
      bloomStrength: version < 2 && bloomStrength === 0 ? DEFAULT_BLOOM_STRENGTH : bloomStrength,
      skin: typeof parsed.skin === 'string' && VALID_SKINS.includes(parsed.skin) ? parsed.skin : 'classic',
      music: parsed.music === true,
      companion: parsed.companion === true,
      companionPets: typeof parsed.companionPets === 'number' ? parsed.companionPets : 0,
      // Absent in every save written before the seal existed, which is exactly
      // the "no seal" state, so a plain default is the right migration.
      companionSeal: parsed.companionSeal === true,
      companionSealPets: typeof parsed.companionSealPets === 'number' ? parsed.companionSealPets : 0,
      // Same again for the jellyfish, which arrived one version later.
      companionJelly: parsed.companionJelly === true,
      companionJellyPets: typeof parsed.companionJellyPets === 'number' ? parsed.companionJellyPets : 0,
      // Same reasoning: absent means the outline toggle never existed yet.
      outlines: parsed.outlines === true,
      // Absent in every save written before the speed slider existed, and 1 is
      // exactly "the rhythm it always had", so a plain default is the migration.
      motionSpeed:
        typeof parsed.motionSpeed === 'number' && Number.isFinite(parsed.motionSpeed)
          ? Math.min(1.8, Math.max(0.4, parsed.motionSpeed))
          : 1,
    }
  } catch {
    return defaults()
  }
}

export function persistSave(save: SaveData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(save))
  } catch {
    // localStorage unavailable (private mode / sandboxed harness) — ignore.
  }
}
