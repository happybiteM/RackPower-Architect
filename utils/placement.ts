/**
 * Rack-mount PDU placement calculator.
 *
 * Given configurable physical dimensions for the rack, each device type and
 * each PDU, this module automatically determines where vertical (0U / 1U)
 * rack-mount PDUs should be installed on the back of the rack so that:
 *   - every PDU + its cord-bend clearance fits inside the rack's usable height,
 *   - PDUs are reachable by the devices they feed (cord-length aware),
 *   - PDUs do not overlap each other or mounted devices' cabling space,
 *   - A/B feeds stay vertically separated where possible.
 */

import {
  Device,
  PDUConfig,
  PhysicalDimensions,
  PlacedPDU,
  PlacementInput,
  PlacementResult,
  PlacementWarning,
  CORD_BEND_CM,
} from '../types';

export const MM_PER_U = 44.45;          // EIA-310-D: 1U = 44.45mm
export const RAIL_OFFSET_MM = 12.7;     // bottom rail to centre of U1 mounting holes
export const DEFAULT_DEVICE_DIM: PhysicalDimensions = { width: 48.26, height: 4.45, depth: 65 };

/** Extra physical inputs (cm / m) carried alongside the standard placement input. */
export interface PlacementCalcInput extends PlacementInput {
  pduPhysicalHeightCm?: number;
  pduCordLengthM?: number;
}

/** Height of a single PDU including its required vertical clearance, in mm. */
export function pduTotalHeightMm(
  pduPhysicalHeightCm: number,
  inletType: keyof typeof CORD_BEND_CM,
): number {
  return pduPhysicalHeightCm * 10 + CORD_BEND_CM[inletType] * 10;
}

/** Convert a PDU's total footprint (body + clearance) into whole U slots. */
export function pduRequiredU(pduPhysicalHeightCm: number, inletType: keyof typeof CORD_BEND_CM): number {
  return Math.max(1, Math.ceil(pduTotalHeightMm(pduPhysicalHeightCm, inletType) / MM_PER_U));
}

/** Vertical extent (mm from rack floor) covered by a device occupying its U span. */
export function deviceOccupiedRangeMm(d: Device, deviceDims: Record<string, PhysicalDimensions>, defaultDim: PhysicalDimensions, offsetMm: number) {
  const dim = deviceDims[d.name] || defaultDim;
  const bodyMm = Math.max(MM_PER_U * d.uHeight, dim.height * 10);
  if (d.uPosition === null) return null;
  const bottomU = d.uPosition - d.uHeight + 1;
  const start = offsetMm + (bottomU - 1) * MM_PER_U;
  return { start, end: start + bodyMm, center: start + bodyMm / 2 };
}

/**
 * Core algorithm.
 * Returns placements (in mounting order from bottom of rack upward) plus warnings.
 */
export function calculatePduPlacement(input: PlacementCalcInput): PlacementResult {
  const {
    rackSizeU,
    devices,
    pdus,
    deviceDims,
    defaultDeviceDim = DEFAULT_DEVICE_DIM,
    pduVertSpaceU = 0,
    pduInletType = 'C14',
    strategy = 'bottom',
  } = input;

  const uHeightMm = input.uHeightMm ?? MM_PER_U;
  const offsetMm = input.offsetMm ?? RAIL_OFFSET_MM;
  const pduHcm = input.pduPhysicalHeightCm ?? 18;
  const cordM = input.pduCordLengthM ?? 3;

  const warnings: PlacementWarning[] = [];

  // --- Resolve per-PDU vertical space (auto vs manual) -----------------------
  const autoU = pdus.length ? pduRequiredU(pduHcm, pduInletType) : 1;
  const spanU = Math.max(1, Math.round(pduVertSpaceU > 0 ? pduVertSpaceU : autoU));
  const clearanceMm = spanU * uHeightMm - pduHcm * 10;

  if (pdus.length * spanU > rackSizeU) {
    warnings.push({
      level: 'error',
      message: `Not enough U space: ${pdus.length} PDUs x ${spanU}U = ${pdus.length * spanU}U exceeds ${rackSizeU}U rack. Reduce PDU count or increase rack size.`,
    });
  }

  // --- Build occupied map ----------------------------------------------------
  // Each U can host at most one PDU unit. Devices block PDUs only when their
  // physical body is taller than their U rating (cable-management clearance).
  const blocked = new Set<number>();
  devices.forEach((d) => {
    const range = deviceOccupiedRangeMm(d, deviceDims, defaultDeviceDim, offsetMm);
    if (!range || d.uPosition === null) return;
    const extraMm = range.end - (offsetMm + d.uPosition * uHeightMm);
    if (extraMm > 0) {
      // tall device spills into the U above it
      const spillU = Math.ceil(extraMm / uHeightMm);
      for (let u = d.uPosition + 1; u <= d.uPosition + spillU && u <= rackSizeU; u++) blocked.add(u);
    }
  });

  // --- Candidate anchor positions (top-most U of a PDU span) -----------------
  const freeSpansFrom = (fromU: number) => {
    const list: number[] = [];
    for (let top = fromU; top >= spanU; top--) {
      let ok = true;
      for (let u = top - spanU + 1; u <= top; u++) if (blocked.has(u)) { ok = false; break; }
      if (ok) list.push(top);
    }
    return list;
  };

  // Preferred anchor depends on strategy and cord reachability.
  const maxReachU = Math.floor((cordM * 1000 - Math.max(0, clearanceMm)) / uHeightMm);
  const mounted = devices.filter((d) => d.uPosition !== null);
  const highestDeviceU = mounted.length ? Math.max(...mounted.map((d) => d.uPosition!)) : rackSizeU;
  const lowestDeviceU = mounted.length ? Math.min(...mounted.map((d) => d.uPosition! - d.uHeight + 1)) : 1;

  let candidates: number[];
  switch (strategy) {
    case 'top':
      candidates = freeSpansFrom(rackSizeU);
      break;
    case 'center': {
      const mid = Math.round(rackSizeU / 2);
      candidates = freeSpansFrom(rackSizeU).sort(
        (a, b) => Math.abs(a - mid) - Math.abs(b - mid),
      );
      break;
    }
    case 'bottom':
    default: {
      // Bottom band, but keep PDUs within cord reach of the lowest devices.
      candidates = freeSpansFrom(Math.min(rackSizeU, Math.max(spanU, lowestDeviceU + Math.max(0, maxReachU))));
      break;
    }
  }

  // --- Assign anchors, alternating A/B sides for separation ------------------
  const placements: PlacedPDU[] = [];
  const used = new Set<number>();
  const takeAnchor = (): number | null => {
    for (const c of candidates) {
      let conflict = false;
      for (let u = c - spanU + 1; u <= c; u++) if (used.has(u)) { conflict = true; break; }
      if (!conflict) {
        for (let u = c - spanU + 1; u <= c; u++) used.add(u);
        return c;
      }
    }
    return null;
  };

  const orderedPdus = [...pdus].sort((a, b) =>
    a.side === b.side ? a.index - b.index : a.side === 'A' ? -1 : 1,
  );

  for (const pdu of orderedPdus) {
    const anchor = takeAnchor();
    if (anchor === null) {
      warnings.push({
        level: 'error',
        message: `${pdu.id}: no contiguous ${spanU}U free slot available for placement.`,
      });
      continue;
    }
    const startU = anchor - spanU + 1;
    const startMm = offsetMm + (startU - 1) * uHeightMm;
    const endMm = startMm + spanU * uHeightMm;
    placements.push({
      pduId: pdu.id,
      side: pdu.side,
      uPosition: anchor,
      uSpan: spanU,
      startMm,
      endMm,
      centerMm: (startMm + endMm) / 2,
      clearanceMm: Math.max(0, clearanceMm),
    });
  }

  // --- Cord-reach advisory ----------------------------------------------------
  if (maxReachU > 0 && mounted.length) {
    const worst = placements.reduce<{ id: string; dist: number } | null>((acc, p) => {
      const pduTopU = p.uPosition;
      const far = Math.max(Math.abs(highestDeviceU - pduTopU), Math.abs(lowestDeviceU - pduTopU));
      if (!acc || far > acc.dist) return { id: p.pduId, dist: far };
      return acc;
    }, null);
    if (worst && worst.dist > maxReachU) {
      warnings.push({
        level: 'warning',
        message: `${worst.id} is ${worst.dist}U from the furthest device but cord reach is ~${maxReachU}U (${cordM} m). Consider longer cords or repositioning.`,
      });
    }
  }

  if (placements.length && strategy === 'bottom') {
    warnings.push({
      level: 'info',
      message: `Placed ${placements.length} rack-mount PDU(s) using ${spanU}U each (${placements.length * spanU}U total) with ${(clearanceMm / 10).toFixed(1)} cm cord-bend clearance.`,
    });
  }

  const totalPduU = placements.reduce((s, p) => s + p.uSpan, 0);
  return {
    placements,
    pduVertSpaceU: spanU,
    totalPduU,
    freeU: Math.max(0, rackSizeU - totalPduU),
    warnings,
  };
}
