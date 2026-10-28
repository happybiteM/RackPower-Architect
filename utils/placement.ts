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
  VerticalChannel,
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
    manualPlacements = {},
    verticalPlacements = {},
  } = input;

  const uHeightMm = input.uHeightMm ?? MM_PER_U;
  const offsetMm = input.offsetMm ?? RAIL_OFFSET_MM;
  const defaultPduHcm = input.pduPhysicalHeightCm ?? 18;
  const cordM = input.pduCordLengthM ?? 3;

  const warnings: PlacementWarning[] = [];

  // --- Split PDUs by form factor --------------------------------------------
  // Vertical (zero-U) PDUs hang on the rear rails and consume no U space.
  // Horizontal PDUs occupy U slots and are placed automatically (or manually).
  const horizontalPdus = pdus.filter(p => p.formFactor === 'horizontal');
  const verticalPdus = pdus.filter(p => p.formFactor !== 'horizontal');

  /** Resolve the U span for a specific horizontal PDU. Rack-based PDUs are
   *  sized directly in U (their configured `uHeight`); cm heights apply only to
   *  vertical strips. Falls back to legacy auto-derivation when uHeight is 0. */
  const spanForPdu = (pdu: PDUConfig): number => {
    if (pdu.uHeight > 0) return Math.max(1, Math.round(pdu.uHeight));
    if (pduVertSpaceU > 0) return Math.max(1, Math.round(pduVertSpaceU));
    const hcm = pdu.physicalHeightCm > 0 ? pdu.physicalHeightCm : defaultPduHcm;
    return pduRequiredU(hcm, pduInletType);
  };

  const makePlacement = (pdu: PDUConfig, anchor: number, spanU: number): PlacedPDU => {
    const startU = anchor - spanU + 1;
    const startMm = offsetMm + (startU - 1) * uHeightMm;
    const endMm = startMm + spanU * uHeightMm;
    // Horizontal PDU body height is defined in U — clearance is whatever the
    // allocated U span leaves beyond the inlet cord bend.
    const bodyMm = Math.max(0, spanU * uHeightMm - CORD_BEND_CM[pduInletType] * 10);
    return {
      pduId: pdu.id,
      side: pdu.side,
      uPosition: anchor,
      uSpan: spanU,
      startMm,
      endMm,
      centerMm: (startMm + endMm) / 2,
      clearanceMm: Math.max(0, endMm - startMm - bodyMm),
      mountSide: pdu.mountSide,
      formFactor: 'horizontal',
      depthCm: pdu.physicalDepthCm > 0 ? pdu.physicalDepthCm : 7.5,
    };
  };

  const placements: PlacedPDU[] = [];
  const used = new Set<number>();          // U slots taken by auto-placed PDUs
  const occupiedByManual = new Set<number>(); // U slots taken by manual PDUs or conflicts

  // --- Pass 1: honour manual placements from the side-view UI ----------------
  for (const pdu of horizontalPdus) {
    const man = manualPlacements[pdu.id];
    if (!man) continue;
    const spanU = spanForPdu(pdu);
    const anchor = Math.min(rackSizeU, Math.max(spanU, Math.round(man.uPosition)));
    const startU = anchor - spanU + 1;
    let conflictWithDevice = false;
    for (let u = startU; u <= anchor; u++) {
      const d = devices.find(
        dev => dev.uPosition !== null && u >= dev.uPosition - dev.uHeight + 1 && u <= dev.uPosition,
      );
      if (d) conflictWithDevice = true;
      if (used.has(u) || occupiedByManual.has(u)) {
        warnings.push({ level: 'error', message: `${pdu.id} (manual) overlaps another PDU at U${u}.` });
      }
      occupiedByManual.add(u);
    }
    if (conflictWithDevice) {
      warnings.push({ level: 'error', message: `${pdu.id} (manual, U${startU}–${anchor}) overlaps a mounted device.` });
    }
    placements.push({ ...makePlacement(pdu, anchor, spanU), mountSide: man.mountSide ?? pdu.mountSide });
  }

  // --- Pass 2: auto-place remaining horizontal PDUs --------------------------
  const autoPdus = horizontalPdus.filter(p => !manualPlacements[p.id]);

  // --- Resolve representative vertical space (for summary display) -----------
  const autoU = autoPdus.length ? pduRequiredU(defaultPduHcm, pduInletType) : 1;
  const spanU = Math.max(1, Math.round(pduVertSpaceU > 0 ? pduVertSpaceU : autoU));
  const clearanceMm = spanU * uHeightMm - defaultPduHcm * 10;

  const totalHorizontalU =
    placements.reduce((s, p) => s + p.uSpan, 0) + autoPdus.length * spanU;
  if (totalHorizontalU > rackSizeU) {
    warnings.push({
      level: 'error',
      message: `Not enough U space: ${horizontalPdus.length} horizontal PDUs need ~${totalHorizontalU}U in a ${rackSizeU}U rack. Reduce PDU count or increase rack size.`,
    });
  }

  // --- Build occupied map ----------------------------------------------------
  // Each U can host at most one PDU unit. Devices block PDUs only when their
  // physical body is taller than their U rating (cable-management clearance).
  const blocked = new Set<number>(occupiedByManual);
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

  const takeAnchor = (): number | null => {
    for (const c of candidates) {
      let conflict = false;
      for (let u = c - spanU + 1; u <= c; u++) if (used.has(u) || blocked.has(u)) { conflict = true; break; }
      if (!conflict) {
        for (let u = c - spanU + 1; u <= c; u++) used.add(u);
        return c;
      }
    }
    return null;
  };

  const orderedPdus = [...autoPdus].sort((a, b) =>
    a.side === b.side ? a.index - b.index : a.side === 'A' ? -1 : 1,
  );

  for (const pdu of orderedPdus) {
    const anchor = takeAnchor();
    if (anchor === null) {
      warnings.push({
        level: 'error',
        message: `${pdu.id}: no contiguous ${spanU}U free slot available for placement. Drag it onto the side view to place it manually.`,
      });
      continue;
    }
    placements.push(makePlacement(pdu, anchor, spanU));
  }

  // --- Vertical PDUs: zero-U strips on the REAR cable channels ----------------
  // The back of the rack offers two lateral channels (left & right). Vertical
  // PDUs hang in these channels without consuming U space, but they may not
  // overlap each other and the sum of their lengths must fit within the rack's
  // usable height. We pack them across the two channels balancing total length
  // (greedy longest-first), honouring manual channel assignments.
  const rackUsableHeightMm = rackSizeU * uHeightMm;
  {
    const vertSorted = [...verticalPdus].sort((a, b) => b.physicalHeightCm - a.physicalHeightCm);
    const channelLoad: Record<VerticalChannel, number> = { left: 0, right: 0 };
    const channelItems: Record<VerticalChannel, PDUConfig[]> = { left: [], right: [] };
    const overflow: PDUConfig[] = [];

    for (const pdu of vertSorted) {
      const lenMm = Math.max(1, (pdu.physicalHeightCm > 0 ? pdu.physicalHeightCm : defaultPduHcm) * 10);
      const manualCh = verticalPlacements[pdu.id]?.channel;
      // Try preferred channel first (manual assignment, else lighter channel).
      const order: VerticalChannel[] = manualCh
        ? [manualCh, manualCh === 'left' ? 'right' : 'left']
        : channelLoad.left <= channelLoad.right ? ['left', 'right'] : ['right', 'left'];
      let placed = false;
      for (const ch of order) {
        if (channelLoad[ch] + lenMm <= rackUsableHeightMm) {
          channelLoad[ch] += lenMm;
          channelItems[ch].push(pdu);
          placed = true;
          if (manualCh && ch !== manualCh) {
            warnings.push({ level: 'warning', message: `${pdu.id}: ${manualCh} rear channel is full — moved to ${ch}.` });
          }
          break;
        }
      }
      if (!placed) overflow.push(pdu);
    }

    if (overflow.length) {
      warnings.push({
        level: 'error',
        message:
          `Vertical PDU overflow: total strip length exceeds rack height even using both rear channels ` +
          `(${Math.ceil((channelLoad.left + channelLoad.right) / uHeightMm)}U needed vs ${rackSizeU}U available). ` +
          `Unplaced: ${overflow.map(p => p.id).join(', ')}.`,
      });
    }

    // Emit placements bottom-up per channel (no overlap guaranteed by packing).
    (['left', 'right'] as VerticalChannel[]).forEach(ch => {
      let cursorMm = offsetMm;
      channelItems[ch].forEach(pdu => {
        const lenMm = Math.max(1, (pdu.physicalHeightCm > 0 ? pdu.physicalHeightCm : defaultPduHcm) * 10);
        const startMm = cursorMm;
        const endMm = cursorMm + lenMm;
        cursorMm = endMm;
        placements.push({
          pduId: pdu.id,
          side: pdu.side,
          uPosition: Math.min(rackSizeU, Math.round(endMm / uHeightMm)),
          uSpan: 0,
          startMm,
          endMm,
          centerMm: (startMm + endMm) / 2,
          clearanceMm: 0,
          mountSide: 'back',
          formFactor: 'vertical',
          channel: ch,
          depthCm: pdu.physicalDepthCm > 0 ? pdu.physicalDepthCm : 7.5,
        });
      });
    });

    if (verticalPdus.length && !overflow.length) {
      warnings.push({
        level: 'info',
        message:
          `Vertical PDUs: left channel ${Math.ceil(channelLoad.left / uHeightMm)}U / ${rackSizeU}U used, ` +
          `right channel ${Math.ceil(channelLoad.right / uHeightMm)}U / ${rackSizeU}U used (zero-U mounting).`,
      });
    }
  }

  // --- Cord-reach advisory ----------------------------------------------------
  if (maxReachU > 0 && mounted.length) {
    const worst = placements.filter(p => p.formFactor === 'horizontal').reduce<{ id: string; dist: number } | null>((acc, p) => {
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

  const totalPduU = placements.reduce((s, p) => s + p.uSpan, 0);

  const horizontalCount = placements.filter(p => p.formFactor === 'horizontal').length;
  if (horizontalCount && strategy === 'bottom') {
    warnings.push({
      level: 'info',
      message: `Placed ${horizontalCount} rack-mount PDU(s) using ~${spanU}U each (${totalPduU}U total). Vertical PDUs mount zero-U on the rear rails.`,
    });
  }
  return {
    placements,
    pduVertSpaceU: spanU,
    totalPduU,
    freeU: Math.max(0, rackSizeU - totalPduU),
    warnings,
  };
}
