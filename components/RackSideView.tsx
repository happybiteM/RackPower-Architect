import React, { useMemo, useRef, useState } from 'react';
import {
  Device,
  PDUConfig,
  PhysicalDimensions,
  PlacementResult,
  ManualPlacementMap,
  VerticalPlacementMap,
  VerticalChannel,
  MountSide,
} from '../types';
import { MM_PER_U, DEFAULT_DEVICE_DIM } from '../utils/placement';

/**
 * RackSideView — interactive side (elevation) view of the rack.
 *
 * - Shows front rail (left) and rear rail (right) with real rack depth to scale.
 * - Devices are drawn as rectangles whose DEPTH equals their configured physical
 *   depth; they can be dragged vertically (U position) and horizontally
 *   (front ↔ back mounting rails).
 * - Horizontal rack-mount PDUs are draggable the same way; dropping them on a
 *   rail records a manual placement that overrides the auto-placement engine.
 * - Vertical (zero-U) PDUs hang in the LEFT or RIGHT cable channel at the back
 *   of the rack. Their strip LENGTH equals their configured physical height and
 *   the placement engine guarantees they never overlap and always fit within
 *   the rack height across the two channels.
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
  onSetVerticalChannel: (pduId: string, channel: VerticalChannel, startCmFromFloor?: number) => void;
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
  onSetVerticalChannel,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ id: string; kind: 'device' | 'pdu' } | null>(null);
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
  const verticalPdus = pdus.filter(p => p.formFactor !== 'horizontal');

  const pduById = useMemo(() => Object.fromEntries(pdus.map(p => [p.id, p])), [pdus]);
  const placedById = useMemo(
    () => Object.fromEntries(placement.placements.filter(p => p.formFactor === 'horizontal').map(p => [p.pduId, p])),
    [placement],
  );
  const vertPlacedById = useMemo(
    () => Object.fromEntries(placement.placements.filter(p => p.formFactor === 'vertical').map(p => [p.pduId, p])),
    [placement],
  );

  // Socket Y lookup for cabling: map (pduId, socketIndex) -> approximate y.
  const socketY = (pduId: string, socketIndex: number): number | null => {
    const pdu = pduById[pduId];
    if (!pdu) return null;
    if (pdu.formFactor === 'vertical') {
      // Strip hangs in its rear channel over its physical length; sockets run top→bottom.
      const pl = vertPlacedById[pduId];
      if (!pl) return null;
      const n = pdu.socketCount + (pdu.secondarySocketCount || 0);
      const frac = n > 1 ? socketIndex / (n - 1) : 0.5;
      const topY = cmToY(pl.endMm / 10);
      const botY = cmToY(pl.startMm / 10);
      return topY + frac * (botY - topY);
    }
    const pl = placedById[pduId];
    if (!pl) return null;
    const bodyTopY = uTopY(pl.uPosition) + 1;
    const bodyH = Math.max(U_HEIGHT_PX * pl.uSpan - 2, 8);
    const n = Math.max(1, pdu.socketCount + (pdu.secondarySocketCount || 0));
    const frac = n > 1 ? socketIndex / (n - 1) : 0.5;
    return bodyTopY + frac * (bodyH - 4) + 2;
  };

  // X position of a vertical PDU strip inside its assigned rear channel.
  const vertStripX = (channel: VerticalChannel, ordinalInChannel: number): number => {
    const w = 7; // strip visual width in px
    const gap = 3;
    // View shows FRONT (left) → BACK (right). The "left" channel of the rack
    // (looking from the front) appears nearer the front rail in this projection.
    if (channel === 'left') return xFrontRail + RAIL_W + 6 + ordinalInChannel * (w + gap);
    return xBackRail - w - 6 - ordinalInChannel * (w + gap);
  };

  const channelOrdinal = (pduId: string, channel: VerticalChannel): number => {
    const ids = placement.placements
      .filter(p => p.formFactor === 'vertical' && p.channel === channel)
      .map(p => p.pduId);
    const idx = ids.indexOf(pduId);
    return idx < 0 ? 0 : idx;
  };

  // ---- Drag handlers ---------------------------------------------------------
  const startDrag = (id: string, kind: 'device' | 'pdu') => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ id, kind });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const yPx = ((e.clientY - rect.top) / rect.height) * totalH;
    const xTotal = ((e.clientX - rect.left) / rect.width) * totalW;

    // Vertical PDU strip → drag selects rear channel (left/right of rack centre)
    // and its top position along the rail (startCmFromFloor).
    if (drag.kind === 'pdu' && pduById[drag.id]?.formFactor === 'vertical') {
      const ch: VerticalChannel = xTotal < MARGIN_X + innerW / 2 ? 'left' : 'right';
      const pl = vertPlacedById[drag.id];
      const lenCm = pl ? (pl.endMm - pl.startMm) / 10 : (pduById[drag.id].physicalHeightCm || 18);
      const rackTopCm = rackSizeU * MM_PER_U / 10;
      const centerCm = yToCm(yPx);
      const startCm = clamp(centerCm + lenCm / 2, lenCm, rackTopCm);
      const cur = verticalPlacements[drag.id];
      if (!cur || cur.channel !== ch || Math.abs((cur.startCmFromFloor ?? -1) - startCm) > 0.5) {
        onSetVerticalChannel(drag.id, ch, startCm);
      }
      setHoverU(clamp(Math.floor((yPx - MARGIN_TOP) / U_HEIGHT_PX) + 1, 1, rackSizeU));
      return;
    }

    const u = uAtClientY(e.clientY);
    setHoverU(u);
    const side: MountSide = xTotal < MARGIN_X + innerW / 2 ? 'front' : 'back';
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
         onPointerDown={startDrag(d.id, 'device')}
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
      return (
        <g key={pdu.id} transform={`translate(${xFrontRail + RAIL_W + 4}, ${MARGIN_TOP + rackH + 6})`}
           style={{ cursor: 'grab' }}
           onPointerDown={startDrag(pdu.id, 'pdu')}
           onPointerMove={handlePointerMove}
           onPointerUp={endDrag}>
          <title>{`${pdu.id}: unplaced — drag into the rack`}</title>
          <rect width={60} height={12} rx={2} fill="none" stroke="#94a3b8" strokeDasharray="3 2" />
          <text x={30} y={9} textAnchor="middle" fontSize={8} fill="#94a3b8">{pdu.id} ⚠</text>
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
    return (
      <g key={pdu.id} style={{ cursor: 'grab' }}
         onPointerDown={startDrag(pdu.id, 'pdu')}
         onPointerMove={handlePointerMove}
         onPointerUp={endDrag}
         onDoubleClick={() => onResetPdu(pdu.id)}>
        <title>{`${pdu.id} (${pdu.side === 'A' ? 'Feed A' : 'Feed B'}) · ${isManual ? 'manual' : 'auto'} @ U${pl.uPosition - pl.uSpan + 1}–${pl.uPosition} · ${pl.mountSide} · depth ${depthCm.toFixed(1)} cm · dbl-click to auto`}</title>
        <rect x={x} y={y} width={w} height={h} rx={2}
              fill={selected ? '#fde68a' : color} opacity={isManual ? 1 : 0.85}
              stroke={isManual ? '#0f172a' : color} strokeWidth={isManual ? 1.6 : 1} />
        {/* sockets row */}
        {Array.from({ length: Math.min(pdu.socketCount, Math.floor(w / 7)) }).map((_, i) => (
          <rect key={i} x={x + 3 + i * 7} y={y + h / 2 - 2} width={4} height={4} rx={1} fill="#ffffff" opacity={0.9} />
        ))}
        <text x={x + w / 2} y={y - 2} textAnchor="middle" fontSize={8} fontWeight={700} fill={color}>{pdu.id}{isManual ? '*' : ''}</text>
      </g>
    );
  };

  const renderVerticalPdu = (pdu: PDUConfig) => {
    const pl = vertPlacedById[pdu.id];
    const color = pdu.side === 'A' ? FEED_A_COLOR : FEED_B_COLOR;
    const manual = verticalPlacements[pdu.id];
    if (!pl) {
      // Could not fit in either rear channel — show as a parked chip.
      return (
        <g key={pdu.id} transform={`translate(${xBackRail + RAIL_W + 10}, ${MARGIN_TOP + rackH + 6})`}>
          <title>{`${pdu.id}: does not fit in the rear channels — reduce quantity or increase rack height`}</title>
          <rect width={54} height={12} rx={2} fill="none" stroke={color} strokeDasharray="3 2" />
          <text x={27} y={9} textAnchor="middle" fontSize={8} fill={color}>{pdu.id} ⚠</text>
        </g>
      );
    }
    const ch = pl.channel ?? 'right';
    const x = vertStripX(ch, channelOrdinal(pdu.id, ch));
    const w = 7;
    const topY = cmToY(pl.endMm / 10);
    const botY = cmToY(pl.startMm / 10);
    const h = Math.max(botY - topY, 4);
    const selected = drag?.id === pdu.id;
    const lenCm = (pl.endMm - pl.startMm) / 10;
    return (
      <g key={pdu.id} style={{ cursor: 'grab' }}
         onPointerDown={startDrag(pdu.id, 'pdu')}
         onPointerMove={handlePointerMove}
         onPointerUp={endDrag}
         onPointerCancel={endDrag}
         onDoubleClick={() => onResetPdu(pdu.id)}>
        <title>{`${pdu.id} vertical zero-U PDU · Feed ${pdu.side} · ${ch} rear channel · length ${lenCm.toFixed(0)} cm (${Math.round(lenCm / MM_PER_U * 10) / 10}U)${manual ? ' · manual, dbl-click to auto' : ''}`}</title>
        <rect x={x} y={topY} width={w} height={h} rx={2}
              fill={selected ? '#fde68a' : color} opacity={selected ? 0.95 : 0.75}
              stroke={manual ? '#0f172a' : color} strokeWidth={manual ? 1.4 : 0.8} />
        {/* socket ticks along the strip */}
        {Array.from({ length: Math.min(pdu.socketCount, Math.max(2, Math.floor(h / 6))) }).map((_, i, arr) => (
          <circle key={i} cx={x + w / 2} cy={topY + ((i + 0.5) / arr.length) * h} r={1.2} fill="#ffffff" opacity={0.9} />
        ))}
        <text x={x + w / 2} y={topY - 3} textAnchor="middle" fontSize={7.5} fontWeight={700} fill={color}>{pdu.id}{manual ? '*' : ''}</text>
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
      if (!pdu) return;
      const color = pdu.side === 'A' ? FEED_A_COLOR : FEED_B_COLOR;
      const dim = deviceDims[d.name] || defaultDeviceDim;
      const depthCm = clamp(dim.depth > 0 ? dim.depth : 65, 2, rackDepthCm - 2);
      const w = depthCm * PX_PER_CM;
      const dx = d.uPosition ? (d.mountSide === 'front' ? xFrontRail + RAIL_W : xBackRail) : 0;
      const outletX = d.mountSide === 'front'
        ? (psuIdx === 0 ? xFrontRail + RAIL_W + 2 : xFrontRail + RAIL_W + w - 2)
        : (psuIdx === 0 ? xBackRail - w + 2 : xBackRail - 2);
      const dy = uTopY(d.uPosition!) + Math.max(d.uHeight * U_HEIGHT_PX - 2, 6) / 2 + 1;
      let ex: number;
      if (pdu.formFactor === 'vertical') {
        const vpl = vertPlacedById[pdu.id];
        if (!vpl) return;
        ex = vertStripX(vpl.channel ?? 'right', channelOrdinal(pdu.id, vpl.channel ?? 'right')) + 3.5;
      } else if (pl) {
        const pdw = clamp(pl.depthCm > 0 ? pl.depthCm : 7.5, 1.5, rackDepthCm - 2) * PX_PER_CM;
        ex = pl.mountSide === 'front' ? xFrontRail + RAIL_W + pdw - 2 : xBackRail - pdw + 2;
      } else return;
      const midY = (dy + sy) / 2;
      cables.push(
        <path key={`${d.id}-${psuIdx}`}
              d={`M ${outletX} ${dy} C ${outletX} ${midY}, ${ex} ${midY}, ${ex} ${sy}`}
              fill="none" stroke={color} strokeWidth={1.3}
              strokeDasharray={psuIdx === 0 ? undefined : '4 3'}
              opacity={0.75} pointerEvents="none" />
      );
      void dx;
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

      {/* Rear zero-U cable channel guides (left & right of rack centre) */}
      <g pointerEvents="none">
        <rect x={xFrontRail + RAIL_W + 3} y={uTopY(rackSizeU)} width={26} height={rackH} fill="#0ea5e9" opacity={0.06} />
        <rect x={xBackRail - 29} y={uTopY(rackSizeU)} width={26} height={rackH} fill="#0ea5e9" opacity={0.06} />
        <text x={xFrontRail + RAIL_W + 16} y={MARGIN_TOP - 4} textAnchor="middle" fontSize={7} fill="#0369a1">L channel</text>
        <text x={xBackRail - 16} y={MARGIN_TOP - 4} textAnchor="middle" fontSize={7} fill="#0369a1">R channel</text>
      </g>

      {/* Vertical PDUs (behind devices) */}
      {verticalPdus.map(renderVerticalPdu)}

      {/* Devices & horizontal PDUs */}
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
        <rect x={470} y={-5} width={5} height={10} fill="#2563eb" opacity={0.75} />
        <text x={479} y={3}>Vertical PDU in rear L/R channel — drag to move, dbl-click to auto</text>
      </g>
    </svg>
  );
};

export default RackSideView;
