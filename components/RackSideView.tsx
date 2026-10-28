import React, { useMemo, useRef, useState } from 'react';
import {
  Device,
  PDUConfig,
  PhysicalDimensions,
  PlacementResult,
  ManualPlacementMap,
  VerticalPlacementMap,
  MountSide,
} from '../types';
import { DEFAULT_DEVICE_DIM } from '../utils/placement';

/**
 * RackSideView — interactive side (elevation) view of the rack.
 *
 * - Shows front rail (left) and rear rail (right) with real rack depth to scale.
 * - Devices are drawn as rectangles whose DEPTH equals their configured physical
 *   depth; they can be dragged vertically (U position) and horizontally
 *   (front ↔ back mounting rails).
 * - Horizontal rack-mount PDUs are draggable the same way; dropping them on a
 *   rail records a manual placement that overrides the auto-placement engine.
 * - Vertical (zero-U) PDUs are intentionally NOT rendered here: they occupy no
 *   rack units and hang in the rear cable channels, so the side view stays a
 *   pure space-planning diagram. They appear in the rear elevation and reports.
 * - Dragging uses a grab offset captured at pointer-down so the component
 *   follows the cursor exactly (no inversion / jump-to-corner behaviour).
 * - Cabling is colour-coded by feed: blue = Feed A, red = Feed B; solid lines
 *   originate at the device's FRONT PSU outlet, dashed lines at the REAR outlet.
 */

interface Props {
  devices: Device[];
  pdus: PDUConfig[];
  placement: PlacementResult;
  manualPlacements: ManualPlacementMap;
  verticalPlacements: VerticalPlacementMap;
  rackSizeU: number;
  rackDepthCm: number;
  deviceDims: Record<string, PhysicalDimensions>;
  defaultDeviceDim?: PhysicalDimensions;
  onPlacePdu: (pduId: string, uPosition: number, mountSide: MountSide) => void;
  onResetPdu: (pduId: string) => void;
  onMoveDevice: (deviceId: string, targetU: number) => void;
  onSetDeviceSide: (deviceId: string, side: MountSide) => void;
}

// ---- Drawing constants ------------------------------------------------------
const PX_PER_CM = 2.6;            // horizontal scale (depth axis)
const U_HEIGHT_PX = 18;           // vertical scale per rack unit
const RAIL_W = 8;                 // rail thickness in px
const MARGIN_X = 56;              // space for U labels on both sides
const MARGIN_TOP = 34;
const MARGIN_BOTTOM = 40;         // legend inside SVG bottom
const FEED_A_COLOR = '#2563eb';   // blue  — Feed A
const FEED_B_COLOR = '#dc2626';   // red   — Feed B

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const RackSideView: React.FC<Props> = ({
  devices,
  pdus,
  placement,
  manualPlacements,
  verticalPlacements,
  rackSizeU,
  rackDepthCm,
  deviceDims,
  defaultDeviceDim = DEFAULT_DEVICE_DIM,
  onPlacePdu,
  onResetPdu,
  onMoveDevice,
  onSetDeviceSide,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    kind: 'device' | 'pdu';
    /** Cursor offset inside the grabbed item (px), captured at pointer-down. */
    grabX: number;
    grabY: number;
    /** Item geometry at pointer-down, used to convert cursor → placement. */
    x0: number;
    y0: number;
    w: number;
    hPx: number;
  } | null>(null);
  const [hoverU, setHoverU] = useState<number | null>(null);

  const depthPx = rackDepthCm * PX_PER_CM;
  const innerW = depthPx + RAIL_W * 2;
  const totalW = innerW + MARGIN_X * 2;
  const rackH = rackSizeU * U_HEIGHT_PX;
  const totalH = rackH + MARGIN_TOP + MARGIN_BOTTOM;

  const xFrontRail = MARGIN_X;
  const xBackRail = MARGIN_X + innerW - RAIL_W;

  /** y of the TOP edge of U `u` (U1 is at the bottom of the rack). */
  const uTopY = (u: number) => MARGIN_TOP + (rackSizeU - u) * U_HEIGHT_PX;
  /** cm from rack floor → y px. */
  const cmToY = (cm: number) => MARGIN_TOP + rackH - (cm / (rackSizeU * MM_PER_U / 10)) * rackH;
  /** y px → cm from rack floor (clamped to rack). */
  const yToCm = (y: number) => {
    const rackTopY = MARGIN_TOP;
    return Math.max(0, Math.min(rackSizeU * MM_PER_U / 10, ((rackTopY + rackH - y) / rackH) * (rackSizeU * MM_PER_U / 10)));
  };
  /** U index under a client Y coordinate (1..rackSizeU). */
  const uAtClientY = (clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return 1;
    const y = ((clientY - rect.top) / rect.height) * totalH;
    return clamp(Math.floor((y - MARGIN_TOP) / U_HEIGHT_PX), 1, rackSizeU);
  };

  const mountedDevices = devices.filter(d => d.uPosition !== null);
  const horizontalPdus = pdus.filter(p => p.formFactor === 'horizontal');

  const pduById = useMemo(() => Object.fromEntries(pdus.map(p => [p.id, p])), [pdus]);
  const placedById = useMemo(
    () => Object.fromEntries(placement.placements.filter(p => p.formFactor === 'horizontal').map(p => [p.pduId, p])),
    [placement],
  );

  // Socket Y lookup for cabling: map (pduId, socketIndex) -> approximate y.
  const socketY = (pduId: string, socketIndex: number): number | null => {
    const pl = placedById[pduId];
    if (!pl) return null;
    const pdu = pduById[pduId];
    if (!pdu || pdu.formFactor === 'vertical') return null; // vertical PDUs not drawn here
    const bodyTopY = uTopY(pl.uPosition) + 1;
    const bodyH = Math.max(U_HEIGHT_PX * pl.uSpan - 2, 8);
    const n = Math.max(1, pdu.socketCount + (pdu.secondarySocketCount || 0));
    const frac = n > 1 ? socketIndex / (n - 1) : 0.5;
    return bodyTopY + frac * (bodyH - 4) + 2;
  };

  /** Convert a client (mouse) point into SVG user-space coordinates. */
  const clientToSvg = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * totalW,
      y: ((clientY - rect.top) / rect.height) * totalH,
    };
  };

  // ---- Drag handlers ---------------------------------------------------------
  // Grab offset is captured at pointer-down so the item follows the cursor
  // exactly — this fixes the previous "inverted drag" where items jumped so
  // their top-left corner landed on the cursor and moved opposite to intent.
  const startDrag = (geom: { id: string; kind: 'device' | 'pdu'; x: number; y: number; w: number; hPx: number }) =>
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      const p = clientToSvg(e.clientX, e.clientY);
      if (!p) return;
      setDrag({ ...geom, grabX: p.x - geom.x, grabY: p.y - geom.y });
    };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = clientToSvg(e.clientX, e.clientY);
    if (!p) return;

    // New top-left of the dragged rectangle (cursor minus grab offset).
    const newX = p.x - drag.grabX;
    const newY = p.y - drag.grabY;

    // Horizontal rail choice from the item's CENTRE (not the cursor), so
    // dragging feels natural near the midline.
    const centerX = newX + drag.w / 2;
    const side: MountSide = centerX < MARGIN_X + innerW / 2 ? 'front' : 'back';

    // Vertical placement: align the item's TOP edge to a U slot. Using the top
    // edge keeps multi-U items from being off-by-one when grabbed mid-body.
    const u = clamp(Math.round((newY - MARGIN_TOP) / U_HEIGHT_PX) + 1, 1, rackSizeU);
    setHoverU(u);

    if (drag.kind === 'device') {
      onMoveDevice(drag.id, u);
      onSetDeviceSide(drag.id, side);
    } else {
      onPlacePdu(drag.id, u, side);
    }
  };

  const endDrag = () => { setDrag(null); setHoverU(null); };

  // ---- Render helpers --------------------------------------------------------
  const renderDevice = (d: Device) => {
    const dim = deviceDims[d.name] || defaultDeviceDim;
    const depthCm = clamp(dim.depth > 0 ? dim.depth : 65, 2, rackDepthCm - 2);
    const w = depthCm * PX_PER_CM;
    const h = Math.max(d.uHeight * U_HEIGHT_PX - 2, 6);
    const y = uTopY(d.uPosition!) + 1;
    const x = d.mountSide === 'front' ? xFrontRail + RAIL_W : xBackRail - w;
    const selected = drag?.id === d.id;
    return (
      <g key={d.id} style={{ cursor: 'grab' }}
         onPointerDown={startDrag({ id: d.id, kind: 'device', x, y, w, hPx: h })}
         onPointerMove={handlePointerMove}
         onPointerUp={endDrag}
         onPointerCancel={endDrag}>
        <title>{`${d.name} · ${d.uHeight}U · depth ${depthCm.toFixed(0)} cm · mounted ${d.mountSide}`}</title>
        <rect x={x} y={y} width={w} height={h} rx={2}
              fill={selected ? '#fbbf24' : '#cbd5e1'} stroke={selected ? '#b45309' : '#64748b'} strokeWidth={1} />
        {/* PSU outlets: left edge = front-facing, right edge = rear-facing */}
        <circle cx={x + 2} cy={y + h / 2} r={2} fill="#0f172a" />
        {d.psuCount > 1 && <circle cx={x + w - 2} cy={y + h / 2} r={2} fill="#0f172a" />}
        {h >= 12 && w > 40 && (
          <text x={x + w / 2} y={y + h / 2 + 3} textAnchor="middle" fontSize={8} fill="#1e293b" pointerEvents="none">
            {d.name.length > Math.floor(w / 5) ? d.name.slice(0, Math.floor(w / 5)) + '…' : d.name}
          </text>
        )}
      </g>
    );
  };

  const renderHorizontalPdu = (pdu: PDUConfig) => {
    const pl = placedById[pdu.id];
    if (!pl) {
      // Unplaced horizontal PDU → parked in tray below the rack (still draggable up).
      const px = xFrontRail + RAIL_W + 4;
      const py = MARGIN_TOP + rackH + 6;
      return (
        <g key={pdu.id}
           style={{ cursor: 'grab' }}
           onPointerDown={startDrag({ id: pdu.id, kind: 'pdu', x: px, y: py, w: 60, hPx: 12 })}
           onPointerMove={handlePointerMove}
           onPointerUp={endDrag}>
          <title>{`${pdu.id}: unplaced — drag into the rack`}</title>
          <rect x={px} y={py} width={60} height={12} rx={2} fill="none" stroke="#94a3b8" strokeDasharray="3 2" />
          <text x={px + 30} y={py + 9} textAnchor="middle" fontSize={8} fill="#94a3b8">{pdu.id} ⚠</text>
        </g>
      );
    }
    const isManual = !!manualPlacements[pdu.id];
    const color = pdu.side === 'A' ? FEED_A_COLOR : FEED_B_COLOR;
    const depthCm = clamp(pl.depthCm > 0 ? pl.depthCm : 7.5, 1.5, rackDepthCm - 2);
    const w = depthCm * PX_PER_CM;
    const h = Math.max(pl.uSpan * U_HEIGHT_PX - 2, 8);
    const y = uTopY(pl.uPosition) + 1;
    const x = pl.mountSide === 'front' ? xFrontRail + RAIL_W : xBackRail - w;
    const selected = drag?.id === pdu.id;
    const inletLabel = pdu.inletType === 'Hardwired' ? 'HW' : pdu.inletType.replace('IEC-309-', '');
    return (
      <g key={pdu.id} style={{ cursor: 'grab' }}
         onPointerDown={startDrag({ id: pdu.id, kind: 'pdu', x, y, w, hPx: h })}
         onPointerMove={handlePointerMove}
         onPointerUp={endDrag}
         onDoubleClick={() => onResetPdu(pdu.id)}>
        <title>{`${pdu.id} (${pdu.side === 'A' ? 'Feed A' : 'Feed B'}) · ${isManual ? 'manual' : 'auto'} @ U${pl.uPosition - pl.uSpan + 1}–${pl.uPosition} · ${pl.mountSide} · depth ${depthCm.toFixed(1)} cm · inlet ${pdu.inletType} · ${pdu.isThreePhase ? '3φ' : '1φ'} ${pdu.supplyVoltage}V ${pdu.ratedCurrent}A (${pdu.circuitCount}×${pdu.breakerRatingA}A) · dbl-click to auto`}</title>
        <rect x={x} y={y} width={w} height={h} rx={2}
              fill={selected ? '#fde68a' : color} opacity={isManual ? 1 : 0.85}
              stroke={isManual ? '#0f172a' : color} strokeWidth={isManual ? 1.6 : 1} />
        {/* inlet marker at the cable-entry end of the body */}
        <rect x={pl.mountSide === 'front' ? x + w - 5 : x + 1} y={y + h / 2 - 3} width={4} height={6} rx={1}
              fill="#ffffff" stroke={color} strokeWidth={0.8} />
        {/* sockets row */}
        {Array.from({ length: Math.min(pdu.socketCount, Math.floor((w - 8) / 7)) }).map((_, i) => (
          <rect key={i} x={x + 6 + i * 7} y={y + h / 2 - 2} width={4} height={4} rx={1} fill="#ffffff" opacity={0.9} />
        ))}
        <text x={x + w / 2} y={y - 2} textAnchor="middle" fontSize={8} fontWeight={700} fill={color}>{pdu.id}{isManual ? '*' : ''} · {inletLabel}</text>
      </g>
    );
  };

  // Cables: device PSU outlet → PDU socket. Solid = from front outlet, dashed = rear outlet.
  const cables: React.ReactNode[] = [];
  mountedDevices.forEach(d => {
    Object.entries(d.psuConnections).forEach(([psuStr, conn]) => {
      if (!conn) return;
      const psuIdx = parseInt(psuStr);
      const sy = socketY(conn.pduId, conn.socketIndex);
      if (sy === null) return;
      const pl = placedById[conn.pduId];
      const pdu = pduById[conn.pduId];
      if (!pdu || !pl) return;
      const color = pdu.side === 'A' ? FEED_A_COLOR : FEED_B_COLOR;
      const dim = deviceDims[d.name] || defaultDeviceDim;
      const depthCm = clamp(dim.depth > 0 ? dim.depth : 65, 2, rackDepthCm - 2);
      const w = depthCm * PX_PER_CM;
      const outletX = d.mountSide === 'front'
        ? (psuIdx === 0 ? xFrontRail + RAIL_W + 2 : xFrontRail + RAIL_W + w - 2)
        : (psuIdx === 0 ? xBackRail - w + 2 : xBackRail - 2);
      const dy = uTopY(d.uPosition!) + Math.max(d.uHeight * U_HEIGHT_PX - 2, 6) / 2 + 1;
      const pdw = clamp(pl.depthCm > 0 ? pl.depthCm : 7.5, 1.5, rackDepthCm - 2) * PX_PER_CM;
      const ex = pl.mountSide === 'front' ? xFrontRail + RAIL_W + pdw - 2 : xBackRail - pdw + 2;
      const midY = (dy + sy) / 2;
      cables.push(
        <path key={`${d.id}-${psuIdx}`}
              d={`M ${outletX} ${dy} C ${outletX} ${midY}, ${ex} ${midY}, ${ex} ${sy}`}
              fill="none" stroke={color} strokeWidth={1.3}
              strokeDasharray={psuIdx === 0 ? undefined : '4 3'}
              opacity={0.75} pointerEvents="none" />
      );
    });
  });

  const uTicks = Array.from({ length: rackSizeU }, (_, i) => i + 1);

  return (
    <svg ref={svgRef} viewBox={`0 0 ${totalW} ${totalH}`} width={totalW} height={totalH}
         role="img" aria-label="Rack side view showing front and rear mounting rails, device depths and PDU placements"
         className="select-none">
      <rect x={0} y={0} width={totalW} height={totalH} fill="#ffffff" rx={8} />
      <text x={totalW / 2} y={14} textAnchor="middle" fontSize={11} fontWeight={700} fill="#0f172a">
        Side View · {rackSizeU}U · {rackDepthCm} cm deep
      </text>
      <text x={xFrontRail + RAIL_W / 2} y={26} textAnchor="middle" fontSize={8} fill="#475569" transform={`rotate(-90 ${xFrontRail + RAIL_W / 2} ${MARGIN_TOP + rackH / 2})`}>FRONT</text>
      <text x={xBackRail + RAIL_W / 2} y={26} textAnchor="middle" fontSize={8} fill="#475569" transform={`rotate(90 ${xBackRail + RAIL_W / 2} ${MARGIN_TOP + rackH / 2})`}>BACK</text>

      {/* Rack shell */}
      <rect x={xFrontRail} y={uTopY(rackSizeU)} width={innerW} height={rackH} fill="#f1f5f9" stroke="#94a3b8" />
      <rect x={xFrontRail} y={uTopY(rackSizeU)} width={RAIL_W} height={rackH} fill="#334155" />
      <rect x={xBackRail} y={uTopY(rackSizeU)} width={RAIL_W} height={rackH} fill="#334155" />

      {/* U grid + labels */}
      {uTicks.map(u => (
        <g key={u}>
          <line x1={xFrontRail + RAIL_W} x2={xBackRail} y1={uTopY(u)} y2={uTopY(u)} stroke="#e2e8f0" strokeWidth={0.5} />
          {(u % 3 === 1) && <>
            <text x={xFrontRail - 6} y={uTopY(u) + U_HEIGHT_PX / 2 + 2} textAnchor="end" fontSize={7} fill="#64748b">{u}</text>
            <text x={xBackRail + RAIL_W + 6} y={uTopY(u) + U_HEIGHT_PX / 2 + 2} fontSize={7} fill="#64748b">{u}</text>
          </>}
        </g>
      ))}

      {/* Hover highlight while dragging */}
      {hoverU !== null && drag && (
        <rect x={xFrontRail + RAIL_W} y={uTopY(hoverU)} width={innerW - RAIL_W * 2} height={U_HEIGHT_PX}
              fill="#fbbf24" opacity={0.25} pointerEvents="none" />
      )}

      {/* Devices & horizontal PDUs (vertical 0U PDUs are not space-planned here —
          they hang in the rear cable channels; see rear elevation & reports) */}
      {mountedDevices.map(renderDevice)}
      {horizontalPdus.map(renderHorizontalPdu)}

      {/* Cables on top */}
      {cables}

      {/* Legend */}
      <g transform={`translate(${MARGIN_X}, ${MARGIN_TOP + rackH + 22})`} fontSize={8} fill="#334155">
        <line x1={0} x2={16} y1={0} y2={0} stroke={FEED_A_COLOR} strokeWidth={1.5} />
        <text x={20} y={3}>Feed A (solid = PSU1/front outlet)</text>
        <line x1={170} x2={186} y1={0} y2={0} stroke={FEED_B_COLOR} strokeWidth={1.5} />
        <text x={190} y={3}>Feed B (dashed = PSU2/rear outlet)</text>
        <rect x={350} y={-5} width={10} height={10} fill="#cbd5e1" stroke="#64748b" />
        <text x={364} y={3}>Device (width = depth)</text>
        <rect x={470} y={-5} width={10} height={10} fill="#2563eb" opacity={0.85} stroke="#0f172a" strokeDasharray="2 1" />
        <text x={484} y={3}>Horizontal PDU (* = manual, dbl-click to auto). Vertical 0U PDUs live in the rear L/R channels — shown in rear view &amp; reports.</text>
      </g>
    </svg>
  );
};

export default RackSideView;
