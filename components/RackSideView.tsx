import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Device,
  PDUConfig,
  PhysicalDimensions,
  PlacementResult,
  ManualPlacementMap,
  VerticalPlacementMap,
  MountSide,
} from '../types';
import { DEFAULT_DEVICE_DIM, MM_PER_U } from '../utils/placement';

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
 * - No cabling is drawn here — this diagram is purely for space planning
 *   (depths, U positions, front/back rails). Cable routing lives in the
 *   front elevation and wiring diagrams.
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
  // Drag state lives in a ref (not React state) so pointer-move never waits for
  // a re-render; the dragged item is drawn from the same ref during render.
  const dragRef = useRef<{
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
  const [dragId, setDragId] = useState<string | null>(null);
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

  const placedById = useMemo(
    () => Object.fromEntries(placement.placements.filter(p => p.formFactor === 'horizontal').map(p => [p.pduId, p])),
    [placement],
  );

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
  // Root cause of the previous "inverted drag": pointer-move was attached to
  // each item's <g>. Once the item moved out from under the cursor (or React
  // re-rendered mid-drag), events stopped firing / fired against stale state,
  // making movement feel reversed and jumpy. Fix: capture the grab offset at
  // pointer-down, then handle ALL move/up events on the <svg> itself via
  // window listeners while dragging. The item follows the cursor exactly from
  // the point you grabbed it.
  const startDrag = (geom: { id: string; kind: 'device' | 'pdu'; x: number; y: number; w: number; hPx: number }) =>
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const p = clientToSvg(e.clientX, e.clientY);
      if (!p) return;
      dragRef.current = {
        id: geom.id, kind: geom.kind,
        grabX: p.x - geom.x, grabY: p.y - geom.y,
        x0: geom.x, y0: geom.y, w: geom.w, hPx: geom.hPx,
      };
      setDragId(geom.id);
    };

  useEffect(() => {
    if (!dragId) return;

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const p = clientToSvg(e.clientX, e.clientY);
      if (!p) return;

      // New top-left of the dragged rectangle (cursor minus grab offset).
      const newX = p.x - d.grabX;
      const newY = p.y - d.grabY;

      // Horizontal rail choice from the item's CENTRE (not the cursor), so
      // dragging feels natural near the midline.
      const centerX = newX + d.w / 2;
      const side: MountSide = centerX < MARGIN_X + innerW / 2 ? 'front' : 'back';

      // Vertical placement: align the item's TOP edge to a U slot. Using the top
      // edge keeps multi-U items from being off-by-one when grabbed mid-body.
      const u = clamp(Math.round((newY - MARGIN_TOP) / U_HEIGHT_PX) + 1, 1, rackSizeU);
      setHoverU(u);

      if (d.kind === 'device') {
        onMoveDevice(d.id, u);
        onSetDeviceSide(d.id, side);
      } else {
        onPlacePdu(d.id, u, side);
      }
    };

    const onUp = () => {
      dragRef.current = null;
      setDragId(null);
      setHoverU(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId, innerW, rackSizeU]);

  // ---- Render helpers --------------------------------------------------------
  const renderDevice = (d: Device) => {
    const dim = deviceDims[d.name] || defaultDeviceDim;
    const depthCm = clamp(dim.depth > 0 ? dim.depth : 65, 2, rackDepthCm - 2);
    const w = depthCm * PX_PER_CM;
    const h = Math.max(d.uHeight * U_HEIGHT_PX - 2, 6);
    const y = uTopY(d.uPosition!) + 1;
    const x = d.mountSide === 'front' ? xFrontRail + RAIL_W : xBackRail - w;
    const selected = dragId === d.id;
    return (
      <g key={d.id} style={{ cursor: selected ? 'grabbing' : 'grab' }}
         onPointerDown={startDrag({ id: d.id, kind: 'device', x, y, w, hPx: h })}>
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
           onPointerDown={startDrag({ id: pdu.id, kind: 'pdu', x: px, y: py, w: 60, hPx: 12 })}>
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
    const selected = dragId === pdu.id;
    const inletLabel = pdu.inletType === 'Hardwired' ? 'HW' : pdu.inletType.replace('IEC-309-', '');
    return (
      <g key={pdu.id} style={{ cursor: selected ? 'grabbing' : 'grab' }}
         onPointerDown={startDrag({ id: pdu.id, kind: 'pdu', x, y, w, hPx: h })}
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
      {hoverU !== null && dragId && (
        <rect x={xFrontRail + RAIL_W} y={uTopY(hoverU)} width={innerW - RAIL_W * 2} height={U_HEIGHT_PX}
              fill="#fbbf24" opacity={0.25} pointerEvents="none" />
      )}

      {/* Devices & horizontal PDUs (vertical 0U PDUs are not space-planned here —
          they hang in the rear cable channels; see rear elevation & reports) */}
      {mountedDevices.map(renderDevice)}
      {horizontalPdus.map(renderHorizontalPdu)}

      {/* Legend */}
      <g transform={`translate(${MARGIN_X}, ${MARGIN_TOP + rackH + 22})`} fontSize={8} fill="#334155">
        <rect x={0} y={-5} width={14} height={10} fill={FEED_A_COLOR} opacity={0.85} rx={2} />
        <text x={18} y={3}>Feed A PDU</text>
        <rect x={110} y={-5} width={14} height={10} fill={FEED_B_COLOR} opacity={0.85} rx={2} />
        <text x={128} y={3}>Feed B PDU</text>
        <rect x={350} y={-5} width={10} height={10} fill="#cbd5e1" stroke="#64748b" />
        <text x={364} y={3}>Device (width = depth)</text>
        <rect x={470} y={-5} width={10} height={10} fill="#2563eb" opacity={0.85} stroke="#0f172a" strokeDasharray="2 1" />
        <text x={484} y={3}>Horizontal PDU (* = manual, dbl-click to auto). Vertical 0U PDUs live in the rear L/R channels — shown in rear view &amp; reports.</text>
      </g>
    </svg>
  );
};

export default RackSideView;
