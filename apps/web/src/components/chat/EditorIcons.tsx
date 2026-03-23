/** Brand icons for supported code editors. */

interface IconProps {
  size?: number;
  className?: string;
}

export function VsCodeIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <mask id="vsc-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M70.912 99.317a6.223 6.223 0 004.932-.639l20.476-10.26A6.25 6.25 0 0099.56 83V17a6.25 6.25 0 00-3.24-5.418L75.844 1.322a6.228 6.228 0 00-7.108.986L29.355 36.94 12.187 24.07a4.162 4.162 0 00-5.318.27L1.38 29.462a4.168 4.168 0 00-.004 6.076L16.17 50 1.376 64.462a4.168 4.168 0 00.004 6.076l5.49 5.122a4.162 4.162 0 005.318.27l17.168-12.87 39.38 34.632a6.215 6.215 0 002.176 1.655zM75.024 27.18L45.096 50l29.928 22.82V27.18z"
          fill="#fff"
        />
      </mask>
      <g mask="url(#vsc-mask)">
        <path d="M96.32 11.582L75.844 1.322a6.228 6.228 0 00-7.108.986L1.376 64.462a4.168 4.168 0 00.004 6.076l5.49 5.122a4.162 4.162 0 005.318.27L96.074 7.674a6.25 6.25 0 00-3.24-5.418" fill="#0065A9" />
        <path d="M96.32 88.418L75.844 98.678a6.228 6.228 0 01-7.108-.986L1.376 35.538a4.168 4.168 0 01.004-6.076l5.49-5.122a4.162 4.162 0 015.318-.27l83.886 62.256a6.25 6.25 0 013.24 5.418" fill="#007ACC" />
        <path d="M75.844 98.678a6.225 6.225 0 007.108-.986 6.244 6.244 0 01-5.612 2.322 6.244 6.244 0 01-5.612-2.322 6.228 6.228 0 004.116.986z" fill="#1F9CF0" />
        <path
          opacity=".25"
          d="M70.912 99.317a6.223 6.223 0 004.932-.639l20.476-10.26A6.25 6.25 0 0099.56 83V17a6.25 6.25 0 00-3.24-5.418L75.844 1.322a6.228 6.228 0 00-7.108.986L29.355 36.94 12.187 24.07a4.162 4.162 0 00-5.318.27L1.38 29.462a4.168 4.168 0 00-.004 6.076L16.17 50 1.376 64.462a4.168 4.168 0 00.004 6.076l5.49 5.122a4.162 4.162 0 005.318.27l17.168-12.87 39.38 34.632a6.215 6.215 0 002.176 1.655z"
          fill="url(#vsc-grad)"
        />
        <defs>
          <linearGradient id="vsc-grad" x1="49.78" y1="0.958" x2="49.78" y2="99.042" gradientUnits="userSpaceOnUse">
            <stop stopColor="#fff" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
      </g>
    </svg>
  );
}

export function ZedIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M530.3 271.4H843l-41.6 73.6H530.3L307.8 731.5h230.4l-41 73.1H108L330.5 418h-186l41.2-73.4h186L530.3 271.4z"
        fill="#F4A261"
      />
      <path
        d="M656.2 509.8h259.8l-41.6 73.6H656.2l-82.7 148.1h230.4l-41 73.1H373.7l82.5-148.1H270.3l41.1-73.6h185.9l82.7-148.1h-186l41.2-73.4h186l35.2-63.1h73.4l-37.6 63.1h-36.3L656.2 509.8z"
        fill="currentColor"
      />
    </svg>
  );
}

export function CursorIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <rect width="28" height="28" rx="5" fill="currentColor" />
      <path
        d="M22.3 13.5L8 4v20l4.8-6.5L17.5 24l3-1.2-4.7-6.8L22.3 13.5z"
        fill="var(--popover)"
      />
    </svg>
  );
}
