import React from 'react'

/**
 * Small line icons, drawn for this film on a 24 by 24 grid: one stroke weight, round ends, the
 * current text colour. `draw` (0..1) traces the strokes in, for icons that arrive with a beat.
 */
type IconProps = { size?: number; color?: string; strokeWidth?: number; draw?: number; style?: React.CSSProperties }

const Icon: React.FC<IconProps & { children: React.ReactNode }> = ({ size = 32, color = 'currentColor', strokeWidth = 1.5, draw = 1, style, children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: 'block', overflow: 'visible', ...style }}
  >
    <g strokeDasharray={draw < 1 ? '1 1' : undefined} strokeDashoffset={draw < 1 ? 1 - draw : undefined}>
      {React.Children.map(children, (child) =>
        React.isValidElement<{ pathLength?: number }>(child) && draw < 1 ? React.cloneElement(child, { pathLength: 1 }) : child,
      )}
    </g>
  </svg>
)

export const FingerprintIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M5.2 8.6A7.6 7.6 0 0 1 18.8 8.6" />
    <path d="M4.4 13.2a7.6 7.6 0 0 1 15.2 0c0 1.6-.2 3-.6 4.2" />
    <path d="M7 19.4c-.6-1.6-.9-3.6-.9-6a5.9 5.9 0 0 1 11.8 0c0 2-.3 3.8-.9 5.4" />
    <path d="M9.6 20.6c-.7-1.9-1.1-4.2-1.1-7.2a3.5 3.5 0 0 1 7 0c0 3-.4 5.3-1.2 7.2" />
    <path d="M12 13.4c0 3 .3 5.3 1 7.2" />
  </Icon>
)

export const KeyIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <circle cx="8" cy="15.5" r="4" />
    <path d="M10.9 12.6 19.5 4" />
    <path d="M16.2 7.3l2.3 2.3" />
    <path d="M13.9 9.6l1.8 1.8" />
  </Icon>
)

export const BotIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <rect x="4.5" y="8" width="15" height="11.5" rx="3.2" />
    <path d="M12 8V5.2" />
    <circle cx="12" cy="4.2" r="1" />
    <path d="M9.4 13.2v.6M14.6 13.2v.6" />
    <path d="M2.5 12.5v3M21.5 12.5v3" />
  </Icon>
)

export const PersonIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="8.2" r="3.7" />
    <path d="M4.8 20c1-3.7 3.8-5.6 7.2-5.6s6.2 1.9 7.2 5.6" />
  </Icon>
)

export const SparkIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M10.5 3.5c.7 4.6 2.6 6.6 7 7.3-4.4.7-6.3 2.7-7 7.3-.7-4.6-2.6-6.6-7-7.3 4.4-.7 6.3-2.7 7-7.3Z" />
    <path d="M18.5 15.5c.3 1.9 1 2.7 2.9 3-1.9.3-2.6 1.1-2.9 3-.3-1.9-1-2.7-2.9-3 1.9-.3 2.6-1.1 2.9-3Z" />
  </Icon>
)

export const CodeIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M8.2 7.2 3.4 12l4.8 4.8" />
    <path d="M15.8 7.2l4.8 4.8-4.8 4.8" />
    <path d="M13.6 5.2l-3.2 13.6" />
  </Icon>
)

export const BlocksIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <rect x="1.8" y="9.2" width="5.6" height="5.6" rx="1.2" />
    <rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1.2" />
    <rect x="16.6" y="9.2" width="5.6" height="5.6" rx="1.2" />
    <path d="M7.4 12h1.8M14.8 12h1.8" />
  </Icon>
)

export const CheckIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M5 12.6l4.4 4.4L19 7.4" />
  </Icon>
)

export const ClockIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.2V12l3.2 2" />
  </Icon>
)

export const GaugeIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M4 17a8.5 8.5 0 1 1 16 0" />
    <path d="M12 13.5l3.8-4" />
    <circle cx="12" cy="14.2" r="1" />
  </Icon>
)

export const MemoIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M3.8 12.4V5.2c0-.8.6-1.4 1.4-1.4h7.2l8 8a1.4 1.4 0 0 1 0 2l-6.2 6.2a1.4 1.4 0 0 1-2 0l-8-8Z" />
    <circle cx="8.4" cy="8.4" r="1.3" />
  </Icon>
)

export const ShieldIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M12 3.2l7 2.8v5.6c0 4.4-2.9 7.6-7 9.2-4.1-1.6-7-4.8-7-9.2V6Z" />
  </Icon>
)

export const VaultIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <rect x="3.5" y="4" width="17" height="15" rx="2.6" />
    <circle cx="12" cy="11.5" r="3.6" />
    <path d="M12 7.9v1.3M12 13.8v1.3M8.4 11.5h1.3M14.3 11.5h1.3" />
    <path d="M6.5 19v1.6M17.5 19v1.6" />
  </Icon>
)

export const NoGasIcon: React.FC<IconProps> = (p) => (
  <Icon {...p}>
    <path d="M12 3.6c2.8 3.4 5.2 6.4 5.2 9.6a5.2 5.2 0 0 1-10.4 0c0-3.2 2.4-6.2 5.2-9.6Z" />
    <path d="M4.5 4.5l15 15" />
  </Icon>
)
