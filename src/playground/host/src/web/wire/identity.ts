import { Career, Player, newPlayer } from "@playground/contracts";

export const PLAYER_KEY = "playground.player";
export const CAREER_KEY = "playground.career";

function read<T>(key: string, parse: (value: unknown) => T | null): T | null {
  try {
    const text = localStorage.getItem(key);
    return text === null ? null : parse(JSON.parse(text));
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be blocked. The page works without it, the player is new on each visit.
  }
}

// The anonymous player of this browser. Made once, kept in localStorage.
export function getPlayer(): Player {
  const stored = read(PLAYER_KEY, (value) => {
    const parsed = Player.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  if (stored) return stored;
  const player = newPlayer(crypto.getRandomValues(new Uint8Array(10)));
  write(PLAYER_KEY, player);
  return player;
}

// The browser's copy of the career, so a reload shows the ladder before the server answers.
export function getCareerCopy(): Career | null {
  return read(CAREER_KEY, (value) => {
    const parsed = Career.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
}

export function saveCareerCopy(career: Career): void {
  write(CAREER_KEY, career);
}
