/**
 * Games the admin can mark as premium. The ids must match `games` in the web app
 * (play-and-learn/src/lib/games.ts); add a line here when a new game ships.
 */
export const gameCatalog = [
  { id: 'alphabet-adventure', title: 'Alphabet Adventure', emoji: '🔤' },
  { id: 'animal-safari', title: 'Animal Safari', emoji: '🦁' },
  { id: 'color-quest', title: 'Color Quest', emoji: '🎨' },
  { id: 'count-the-stars', title: 'Count the Stars', emoji: '⭐' },
  { id: 'shape-safari', title: 'Shape Safari', emoji: '🔺' },
] as const;

export const gameIds: readonly string[] = gameCatalog.map((game) => game.id);
