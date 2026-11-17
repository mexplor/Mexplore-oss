export const SERIES = {
  read: { label: 'read', color: '#1d7486' },
  manage: { label: 'manage', color: '#c2410c' },
  combined: { label: 'combined', color: '#2a251f' },
} as const
export type SeriesKey = keyof typeof SERIES
