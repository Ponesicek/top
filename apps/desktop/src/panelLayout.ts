export const PANEL_MIN = 280;
export const PANEL_DEFAULT = 460;
/** The narrowest the conversation gets beside the Files panel. */
export const CHAT_MIN = 340;
export const SIDEBAR = 280;
/** At this width and under, the sidebar is a column of avatars and panels cover the conversation. */
export const NARROW = 720;

export type PanelLayout = { readonly overlay: boolean; readonly width: number };

/**
 * Where the Files panel goes in a window this wide: beside the conversation, at the width it was given but never so
 * wide that the conversation gets under CHAT_MIN; or, when even its narrowest doesn't fit, over the conversation.
 */
export function panelLayout(viewport: number, stored: number): PanelLayout {
  const want = Math.max(PANEL_MIN, Number.isFinite(stored) ? stored : PANEL_DEFAULT);
  if (viewport <= NARROW) return { overlay: true, width: viewport };
  const room = viewport - SIDEBAR - CHAT_MIN;
  if (room >= PANEL_MIN) return { overlay: false, width: Math.min(want, room) };
  return { overlay: true, width: Math.min(want, viewport - SIDEBAR) };
}

/** The widest a drag may make the panel beside the conversation. */
export const panelMax = (viewport: number) => Math.max(PANEL_MIN, viewport - SIDEBAR - CHAT_MIN);
