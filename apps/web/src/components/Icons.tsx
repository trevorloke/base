import type { PillarIcon as PillarIconName } from "@/content/site";

const paths: Record<PillarIconName, React.ReactNode> = {
  shield: (
    <>
      <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  bus: (
    <>
      <rect x="4" y="3" width="16" height="14" rx="2" />
      <path d="M4 10h16" />
      <path d="M8 17v2M16 17v2" />
      <path d="M8 14h.01M16 14h.01" />
    </>
  ),
  trend: (
    <>
      <path d="M4 19l6-6 4 4 6-7" />
      <path d="M15 10h5v5" />
    </>
  ),
  tag: (
    <>
      <path d="M3 12l9-9h8v8l-9 9-8-8z" />
      <circle cx="16" cy="7" r="1.5" />
    </>
  ),
  civic: (
    <>
      <path d="M3 21h18" />
      <path d="M5 21V10h14v11" />
      <path d="M12 3l8 6H4l8-6z" />
      <path d="M10 21v-5h4v5" />
    </>
  ),
};

export function PillarIcon({ name }: { name: PillarIconName }) {
  return (
    <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7F8CA6" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function StopDougSign() {
  return (
    <svg role="img" aria-label="Stop Doug sign" width="150" height="150" viewBox="0 0 100 100" style={{ flex: "none", display: "block" }}>
      <polygon points="29.3,2 70.7,2 98,29.3 98,70.7 70.7,98 29.3,98 2,70.7 2,29.3" fill="#EF2023" />
      <polygon points="31.8,7.8 68.2,7.8 92.2,31.8 92.2,68.2 68.2,92.2 31.8,92.2 7.8,68.2 7.8,31.8" fill="none" stroke="#FFFFFF" strokeWidth="3.5" />
      <text x="50" y="46" textAnchor="middle" fontFamily="inherit" fontWeight="900" fontSize="21" fill="#FFFFFF" letterSpacing="1">
        STOP
      </text>
      <text x="50" y="70" textAnchor="middle" fontFamily="inherit" fontWeight="900" fontSize="21" fill="#FFFFFF" letterSpacing="1">
        DOUG
      </text>
    </svg>
  );
}

export function SkyTrainMap() {
  const extension = [
    { y: 196, name: "96 Avenue", sub: "Surrey Memorial Hospital" },
    { y: 258, name: "88 Avenue", sub: "Bear Creek Park" },
    { y: 314, name: "80 Avenue" },
    { y: 376, name: "72 Avenue", sub: "Newton" },
    { y: 438, name: "64 Avenue", sub: "Panorama" },
    { y: 506, name: "Highway 10", sub: "Courthouse and Old City Hall" },
    { y: 568, name: "South Surrey Park & Ride", sub: "At the Nicomekl River" },
  ];
  return (
    <svg viewBox="0 0 440 640" role="img" aria-labelledby="skytrain-map-title" style={{ display: "block", width: "100%", maxWidth: 440, height: "auto", fontFamily: "inherit" }}>
      <title id="skytrain-map-title">
        Schematic map of SkyTrain along King George Boulevard: the existing line to King George Station, where the Surrey Langley line branches
        east, and the proposed extension through Surrey Memorial Hospital, Bear Creek Park, Newton, Panorama at 64 Avenue, and Highway 10 to the
        South Surrey Park and Ride. Provincial parties have committed to 72 Avenue, Mayor McCallum promised 64 Avenue, and Imagine Surrey will build
        SkyTrain all the way to the South Surrey Park and Ride at the Nicomekl River.
      </title>
      <path d="M90 36 L90 128" stroke="#003979" strokeWidth="12" strokeLinecap="round" fill="none" />
      <path d="M90 24 L84 34 L96 34 Z" fill="#003979" />
      <path d="M90 134 L90 568" stroke="#EF2023" strokeWidth="12" strokeDasharray="14 10" fill="none" />
      <circle cx="90" cy="58" r="10" fill="#FFFFFF" stroke="#003979" strokeWidth="5" />
      <text x="112" y="63" fontSize="15" fontWeight="700" fill="#0F1E33">
        Surrey Central
      </text>
      <path d="M103 128 L300 128 L340 162" stroke="#7F8CA6" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M352 172 L336 170 L344 156 Z" fill="#7F8CA6" />
      <text x="214" y="152" fontSize="13" fontWeight="700" fill="#4A5872">
        To Langley
      </text>
      <circle cx="90" cy="128" r="10" fill="#FFFFFF" stroke="#003979" strokeWidth="5" />
      <text x="112" y="114" fontSize="17" fontWeight="800" fill="#003979">
        King George Station
      </text>
      {extension.map((s) => (
        <g key={s.name}>
          <circle cx="90" cy={s.y} r="10" fill="#FFFFFF" stroke="#EF2023" strokeWidth="5" />
          <text x="112" y={s.sub ? s.y - 4 : s.y + 5} fontSize="16" fontWeight="800" fill="#0F1E33">
            {s.name}
          </text>
          {s.sub && (
            <text x="112" y={s.y + 15} fontSize="13" fontWeight="600" fill="#4A5872">
              {s.sub}
            </text>
          )}
        </g>
      ))}
      <rect x="232" y="365" width="204" height="22" rx="11" fill="#4A5872" />
      <text x="334" y="380" fontSize="11" fontWeight="800" letterSpacing="0.6" fill="#FFFFFF" textAnchor="middle">
        PROVINCIAL PARTIES: 72 AVE
      </text>
      <rect x="232" y="427" width="204" height="22" rx="11" fill="#003979" />
      <text x="334" y="442" fontSize="11" fontWeight="800" letterSpacing="0.6" fill="#FFFFFF" textAnchor="middle">
        McCALLUM PROMISED: 64 AVE
      </text>
      <rect x="18" y="603" width="404" height="24" rx="12" fill="#FFF100" />
      <text x="220" y="619" fontSize="10.5" fontWeight="800" letterSpacing="0.2" fill="#003979" textAnchor="middle">
        IMAGINE SURREY WILL BUILD SKYTRAIN TO SOUTH SURREY
      </text>
    </svg>
  );
}

/** A person in a circle: the supporter sign-in. */
export function SignInIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
      <circle cx="12" cy="12" r="9.5" />
      <circle cx="12" cy="10" r="3.2" />
      <path d="M6 18.6a7 7 0 0 1 12 0" />
    </svg>
  );
}

export function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ flex: "none" }}>
      {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
    </svg>
  );
}
