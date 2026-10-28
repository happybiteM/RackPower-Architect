
export interface RawCsvRow {
  Room: string;
  Device: string;
  "Rack Size (U)": string;
  "Total No. of Device": string;
  "Total No. of PS": string;
  "PSU Rating (Watt)": string;
  "Typical Power (Watt)": string;
  "Max Power (Watt)": string;
  "Total Max Power Consumption (Watt)": string;
  "Power Connection Type": string;
}

export interface PSUConnection {
  pduId: string; // Changed from 'A'|'B' to specific ID
  socketIndex: number; // 0-based index on the PDU
}

/** Which side of the rack a component is mounted on (side view convention). */
export type MountSide = 'front' | 'back';

export interface Device {
  id: string;
  name: string;
  room: string;
  psuCount: number;
  typicalPower: number;
  powerRatingPerDevice: number;
  connectionType: string;
  // Physical attributes
  uHeight: number;
  uPosition: number | null; // Top-most U position (1-48)
  mountSide: MountSide;     // Front or rear mounting rails (side view)
  // New granular connection state
  psuConnections: { [psuIndex: number]: PSUConnection | null };
}

export type SocketType = 'UK' | 'C13' | 'C19';

/** How a PDU is physically installed in the rack. */
export type PduFormFactor = 'vertical' | 'horizontal';

/** IEC 60309 / hard-wired inlet options for the PDU power input. */
export type PduInletType = 'C14' | 'C20' | 'IEC-309-16A' | 'IEC-309-32A' | 'Hardwired';

export const INLET_MAX_AMPS: Record<PduInletType, number> = {
  'C14': 16,
  'C20': 20,
  'IEC-309-16A': 16,
  'IEC-309-32A': 32,
  'Hardwired': 63,
};

/**
 * Wire-size & breaker guidance per inlet rating (single-phase 230 V, copper,
 * clipped-conduit reference — indicative only; verify against local code).
 */
export const INLET_WIRE_MM2: Record<PduInletType, string> = {
  'C14': '2.5 mm² / 16 A',
  'C20': '2.5 mm² / 20 A',
  'IEC-309-16A': '2.5 mm² / 16 A',
  'IEC-309-32A': '4–6 mm² / 32 A',
  'Hardwired': '10 mm² / 63 A',
};

export interface PDUConfig {
  id: string;
  side: 'A' | 'B'; // Visual side
  index: number; // Pair index (0, 1, 2...)
  
  // Primary Group
  socketType: SocketType;
  socketCount: number;
  
  // Secondary Group
  secondarySocketType?: SocketType;
  secondarySocketCount?: number;

  powerCapacity: number;

  // --- Power input configuration (shared by vertical & horizontal PDUs) -----
  /** Plug/inlet type that feeds the PDU from the branch circuit. */
  inletType: PduInletType;
  supplyVoltage: number;      // V
  ratedCurrent: number;       // A per phase/line
  isThreePhase: boolean;
  /** Number of protected line inputs / internal branch circuits. */
  circuitCount: number;
  breakerRatingA: number;     // upstream branch-circuit breaker rating (A)

  // --- Rack-mount attributes (side-view placement) --------------------------
  /** vertical = zero-U strip on rear rails; horizontal = rack unit placed via side view. */
  formFactor: PduFormFactor;
  /** Front or rear mounting rail for horizontal PDUs (default: back). */
  mountSide: MountSide;
  /** Manual U position override (top-most occupied U). Null = auto placement. */
  uPosition: number | null;
  /** Physical body height in cm (used by placement calc & side-view drawing). */
  physicalHeightCm: number;
  /** Physical body depth in cm (drawn to scale in the side view). */
  physicalDepthCm: number;
}

export interface RackGroup {
  roomId: string;
  devices: Device[];
  totalPower: number;
}

export interface PDUPair {
  id: string;
  capacity: number;
  currentLoad: number;
  devices: Device[];
}

export interface OptimizationResult {
  roomId: string;
  pduPairs: PDUPair[];
  unassignedDevices: Device[];
}

// ---------- Physical dimensions & rack-mount PDU placement ----------

/** Real-world physical dimensions (centimetres) for a component type. */
export interface PhysicalDimensions {
  width: number;   // cm
  height: number;  // cm
  depth: number;   // cm
}

/** Rack size catalogue: external dims + usable mounting height in U. */
export const RACK_SIZES: Record<string, { label: string; external: PhysicalDimensions; internalU: number }> = {
  '6U':  { label: 'Wall-mount 6U',    external: { width: 48.3, height: 35,  depth: 45 },   internalU: 6 },
  '12U': { label: 'Floor/Wall 12U',   external: { width: 60,   height: 67,  depth: 80 },   internalU: 12 },
  '22U': { label: 'Half-height 22U',  external: { width: 60,   height: 119, depth: 80 },   internalU: 22 },
  '27U': { label: 'Half-height 27U',  external: { width: 60,   height: 140, depth: 80 },   internalU: 27 },
  '42U': { label: 'Standard 42U',     external: { width: 60,   height: 200, depth: 107 },  internalU: 42 },
  '45U': { label: 'Tall 45U',         external: { width: 60,   height: 220, depth: 107 },  internalU: 45 },
  '47U': { label: 'Tall 47U',         external: { width: 60,   height: 225, depth: 120 },  internalU: 47 },
  '48U': { label: 'Full-height 48U',  external: { width: 60,   height: 230, depth: 120 },  internalU: 48 },
};

/** Vertical zero-U space required above a rack-mounted PDU for its inlet cord bend. */
export const CORD_BEND_CM: Record<'C13' | 'C14' | 'C19' | 'C20', number> = {
  C13: 5, C14: 5, C19: 6, C20: 6,
};

export type PduPlacementStrategy = 'bottom' | 'top' | 'center';

export interface PlacementInput {
  rackSizeU: number;
  devices: Device[];
  pdus: PDUConfig[];
  /** Height of one rack unit in mm (44.45 standard). */
  uHeightMm?: number;
  /** Mounting offset from the bottom rail to centre of U1 holes, in mm. */
  offsetMm?: number;
  deviceDims: Record<string, PhysicalDimensions>;
  defaultDeviceDim: PhysicalDimensions;
  pduVertSpaceU: number;       // 0 = auto-calculate from physical height
  pduInletType: keyof typeof CORD_BEND_CM;
  strategy: PduPlacementStrategy;
  /** Manual placements coming from the side-view UI (override auto placement). */
  manualPlacements?: ManualPlacementMap;
  /** Manual lateral channel assignments for vertical (zero-U) PDUs. */
  verticalPlacements?: VerticalPlacementMap;
}

export interface PlacedPDU {
  pduId: string;
  side: 'A' | 'B';
  uPosition: number;      // top-most occupied U (same convention as devices)
  uSpan: number;          // how many U it occupies
  startMm: number;        // bottom edge from rack floor
  endMm: number;          // top edge from rack floor
  centerMm: number;       // vertical centre from rack floor
  clearanceMm: number;    // cord-bend clearance reserved above
  mountSide: MountSide;   // front or rear rail (side view)
  formFactor: PduFormFactor;
  /** Lateral channel on the rear zero-U space (vertical PDUs only). */
  channel?: VerticalChannel;
  depthCm: number;        // physical body depth for side-view drawing
}

/** Manual placement request for a horizontal PDU (from the side-view UI). */
export interface PduManualPlacement {
  uPosition: number;      // top-most occupied U
  mountSide: MountSide;
}

/** Lateral channel of the rear zero-U space where a vertical PDU hangs. */
export type VerticalChannel = 'left' | 'right';

/** Manual placement for a vertical (zero-U) PDU on the rear rails. */
export interface VerticalPlacement {
  channel: VerticalChannel;
  /** Top edge of the PDU strip, in cm measured from the rack floor. */
  startCmFromFloor?: number;
}

export type ManualPlacementMap = Record<string, PduManualPlacement>;
export type VerticalPlacementMap = Record<string, VerticalPlacement>;

// ---------------- PDU Library (PDUs treated like devices) -------------------

/** A user-defined PDU *type* with its parameters and available quantity. */
export interface PduType {
  id: string;
  name: string;
  formFactor: PduFormFactor;
  socketType: SocketType;
  socketCount: number;
  secondarySocketType?: SocketType;
  secondarySocketCount?: number;
  /** Same power-rating configuration used for every rack-based PDU. */
  powerCapacity: number;
  // --- Power input configuration (inlet + supply) ---------------------------
  inletType: PduInletType;
  supplyVoltage: number;      // V
  ratedCurrent: number;       // A per phase/line
  isThreePhase: boolean;
  circuitCount: number;       // protected line inputs / branch circuits
  breakerRatingA: number;     // upstream breaker rating (A)
  /** Physical body height in cm (vertical strips: length along the rail). */
  physicalHeightCm: number;
  /** Physical body width in cm (horizontal PDUs — faceplate width). */
  physicalWidthCm: number;
  /** Physical body depth in cm (drawn to scale in the side view). */
  physicalDepthCm: number;
  /** Socket column layout on the PDU face (1 = single column, 2 = wide). */
  cols: number;
  /** Default mounting rail for horizontal PDUs of this type. */
  mountSide: MountSide;
  /** How many PDUs of this type are available (quantity selector). */
  quantity: number;
}

/** Reserved lateral width (cm) of each rear zero-U cable channel. */
export const VERTICAL_CHANNEL_WIDTH_CM = 5.5;

export interface PlacementWarning {
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface PlacementResult {
  placements: PlacedPDU[];
  pduVertSpaceU: number;              // resolved value actually used
  totalPduU: number;                  // U consumed by all PDUs
  freeU: number;                      // remaining usable U for devices
  warnings: PlacementWarning[];
}
