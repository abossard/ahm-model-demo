import { advanceCareer, NEW_CAREER } from "@playground/contracts";
import type { Career, CareerEvent, Player } from "@playground/contracts";
import type { Store } from "./ports";

interface Profile {
  id: string;
  handle: string;
  career: Career;
  pings: number;
}

export interface Careers {
  // The caller's career. Also keeps the stored handle current.
  get(player: Player): Promise<Career>;
  advance(playerId: string, event: CareerEvent): Promise<Career>;
  pings(player: Player): Promise<number>;
}

const CACHE_LIMIT = 5000;
const UNKNOWN_HANDLE = "Visitor";

export function createCareers(store: Store): Careers {
  const cache = new Map<string, Profile>();

  function remember(profile: Profile): Profile {
    cache.delete(profile.id);
    cache.set(profile.id, profile);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return profile;
  }

  async function write(id: string, change: (profile: Profile | null) => Profile): Promise<Profile> {
    const doc = await store.update<Profile>("players", id, id, change);
    return remember(doc!.body);
  }

  return {
    async get(player) {
      const cached = cache.get(player.id);
      if (cached && cached.handle === player.handle) return cached.career;
      const profile = await write(player.id, (body) =>
        body && body.handle === player.handle ? body : { id: player.id, handle: player.handle, career: body?.career ?? NEW_CAREER, pings: body?.pings ?? 0 },
      );
      return profile.career;
    },

    async advance(playerId, event) {
      const profile = await write(playerId, (body) => {
        const current = body ?? { id: playerId, handle: cache.get(playerId)?.handle ?? UNKNOWN_HANDLE, career: NEW_CAREER, pings: 0 };
        const career = advanceCareer(current.career, event);
        const pings = current.pings + (event.type === "hello_ping" ? 1 : 0);
        return body && career === current.career && pings === current.pings ? body : { ...current, career, pings };
      });
      return profile.career;
    },

    async pings(player) {
      await this.get(player);
      return cache.get(player.id)?.pings ?? 0;
    },
  };
}
