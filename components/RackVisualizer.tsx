
import React, { useState } from 'react';
import { Device, PSUConnection, PDUConfig, SocketType } from '../types';
import { Plug, Zap, AlertTriangle } from 'lucide-react';

interface Props {
  devices: Device[];
  onMoveDevice: (deviceId: string, targetU: number) => void;
  onUpdateConnection: (deviceId: string, psuIndex: number, pduId: string | null, socketIndex: number|null) => void;
  pdus: PDUConfig[];
  pduLoads: Record<string, { typical: number, max: number }>;
  powerFactor: number;
  safetyMargin: number;
  pduPhysicalHeight: number; // in cm
  pduPhysicalWidth: number; // in cm
  pduCordLength: number; // in m
  rackSize: number;
  voltage: number;
  circuitCount: number;
  circuitRating: number;
  isThreePhase: boolean;
  pduCols: number;
}

const U_HEIGHT_PX = 30; // Reduced from 45
const RACK_HEADER_HEIGHT = 16;

// Layout Constants (Pixels)
const TABLE_WIDTH = 300; // New summary table on the left
const WIRE_GAP = 120;
const PDU_VERTICAL_GAP = 20;
const TOP_OFFSET = 60; // Space for Rack Name Header

const PDU_HEADER_H = 40;
const PDU_FOOTER_H = 40;
const SOCKET_H = 14; 
const SOCKET_GAP = 4;
const SOCKET_PADDING = 8;

const CIRCUIT_HEADER_HEIGHT = 20;
const CIRCUIT_HEADER_MARGIN = 4;

// Updated Styles for White Background (Paper Mode)
const THEME = {
  bg: 'bg-white',
  text: 'text-slate-900',
  textDim: 'text-slate-600',
  border: 'border-slate-300',
  rackBg: 'bg-slate-800', // Darker rack
  rackBorder: 'border-slate-600', // Darker border
  deviceBg: 'bg-slate-300', // Light Grey for devices
  deviceBorder: 'border-slate-400',
  deviceHover: 'hover:bg-slate-200',
  rail: 'bg-slate-950' // Dark rails
};

const SocketIcon = ({ type, used, label, hovered, labelSide = 'left' }: { type: SocketType, used: boolean, label: string, hovered: boolean, labelSide?: 'left' | 'right' }) => {
    let borderColor = 'border-slate-600';
    let bgColor = 'bg-slate-800';
    let ring = '';
    const pinColorClass = (isUsed: boolean) => isUsed ? 'bg-emerald-400' : 'bg-slate-600';

    if (used) {
        borderColor = 'border-emerald-500';
        bgColor = 'bg-emerald-900/50';
    }
    
    if (hovered) {
         borderColor = 'border-blue-400';
         bgColor = used ? 'bg-blue-900/40' : 'bg-blue-900/30';
         ring = 'ring-2 ring-blue-500 z-50'; 
    }

    const baseClass = `relative border rounded flex flex-col items-center justify-center shadow-sm transition-all duration-200 
      ${borderColor} ${bgColor} ${ring}
    `;

    const style = { height: `${SOCKET_H}px`, width: '28px' };
    
    const labelClass = labelSide === 'left' 
        ? "absolute -left-8 text-[8px] text-slate-400 w-6 text-right font-mono"
        : "absolute -right-8 text-[8px] text-slate-400 w-6 text-left font-mono";

    if (type === 'UK') {
        return (
            <div className={baseClass} style={style}>
                <div className="flex gap-[2px] items-center">
                    <div className={`w-[2px] h-[3px] ${pinColorClass(used)} rounded-sm`}></div>
                    <div className={`w-[2px] h-[3px] ${pinColorClass(used)} rounded-sm`}></div>
                    <div className={`w-[2px] h-[3px] ${pinColorClass(used)} rounded-sm`}></div>
                </div>
                <span className={labelClass}>{label}</span>
            </div>
        );
    }
    if (type === 'C13') {
         return (
            <div className={baseClass} style={style}>
                 <div className="flex gap-[2px]">
                    <div className={`w-[2px] h-[2px] ${pinColorClass(used)} rounded-full`}></div>
                    <div className={`w-[2px] h-[2px] ${pinColorClass(used)} rounded-full`}></div>
                    <div className={`w-[2px] h-[2px] ${pinColorClass(used)} rounded-full`}></div>
                </div>
                <span className={labelClass}>{label}</span>
            </div>
         );
    }
    // C19
    return (
        <div className={baseClass} style={style}>
             <div className="flex gap-[2px]">
                <div className={`w-[2px] h-[3px] ${pinColorClass(used)}`}></div>
                <div className={`w-[2px] h-[3px] ${pinColorClass(used)}`}></div>
             </div>
             <span className={labelClass}>{label}</span>
        </div>
    );
};

const RackVisualizer: React.FC<Props> = ({ 
  devices, 
  onMoveDevice, 
  onUpdateConnection,
  pdus,
  pduLoads,
  powerFactor,
  safetyMargin,
  pduPhysicalHeight,
  pduPhysicalWidth,
  pduCordLength,
  rackSize,
  voltage,
  circuitCount,
  circuitRating,
  isThreePhase,
  pduCols
}) => {
  const [draggedDevice, setDraggedDevice] = useState<string | null>(null);
  const [draggedCable, setDraggedCable] = useState<{deviceId: string, psuIndex: number} | null>(null);
  const [hoveredSocket, setHoveredSocket] = useState<{pduId: string, index: number} | null>(null);

  // Dynamic Layout Constants
  const currentPduWidth = pduCols === 2 ? 90 : 60;
  const currentPduColWidth = pduCols === 2 ? 110 : 80;
  const RACK_WIDTH = 420;

  // Derive RACK HEIGHT based on prop
  const rackHeightPx = (rackSize * U_HEIGHT_PX) + (RACK_HEADER_HEIGHT * 2);

  const pdusA = pdus.filter(p => p.side === 'A');
  const pdusB = pdus.filter(p => p.side === 'B');

  const unmountedDevices = devices.filter(d => d.uPosition === null);

  // --- Layout Calculations ---
  
  // Shift everything by TABLE_WIDTH
  const rackLeftX = TABLE_WIDTH + currentPduColWidth + WIRE_GAP;
  const rackRightX = rackLeftX + RACK_WIDTH;
  const totalWidth = rackRightX + WIRE_GAP + currentPduColWidth;

  const getPDUHeight = (socketCount: number) => {
      const socketsPerCircuit = Math.ceil(socketCount / circuitCount);
      const rows = Math.ceil(socketCount / pduCols);
      
      let h = PDU_HEADER_H + SOCKET_PADDING;
      
      for(let r=0; r<rows; r++) {
          const firstS = r * pduCols;
          // Check for circuit header
          // Note: Logic must match render loop EXACTLY
          const isStartCircuit = (firstS === 0) || (firstS > 0 && firstS % socketsPerCircuit === 0);
          
          if (isStartCircuit) {
              h += CIRCUIT_HEADER_HEIGHT + CIRCUIT_HEADER_MARGIN;
          }
          
          h += SOCKET_H;
          if (r < rows - 1) h += SOCKET_GAP;
      }
      
      h += SOCKET_PADDING + PDU_FOOTER_H;
      return h;
  };

  const getGroupStartY = (groupPdus: PDUConfig[]) => {
      if (groupPdus.length === 0) return 0;
      const totalH = groupPdus.reduce((sum, p) => sum + getPDUHeight(p.socketCount + (p.secondarySocketCount || 0)), 0) + ((groupPdus.length - 1) * PDU_VERTICAL_GAP);
      return Math.max(0, (rackHeightPx - totalH) / 2);
  };

  // Helper for container sizing
  const getGroupTotalHeight = (groupPdus: PDUConfig[]) => {
      if (groupPdus.length === 0) return 0;
      return groupPdus.reduce((sum, p) => sum + getPDUHeight(p.socketCount + (p.secondarySocketCount || 0)), 0) + ((groupPdus.length - 1) * PDU_VERTICAL_GAP);
  };

  const startYA = getGroupStartY(pdusA);
  const startYB = getGroupStartY(pdusB);

  const getPDURect = (pdu: PDUConfig) => {
      const isA = pdu.side === 'A';
      const group = isA ? pdusA : pdusB;
      const indexInGroup = group.findIndex(p => p.id === pdu.id);
      
      let y = isA ? startYA : startYB;
      for (let i = 0; i < indexInGroup; i++) {
          const totalSockets = group[i].socketCount + (group[i].secondarySocketCount || 0);
          y += getPDUHeight(totalSockets) + PDU_VERTICAL_GAP;
      }

      const totalSockets = pdu.socketCount + (pdu.secondarySocketCount || 0);

      // X calculation includes TABLE_WIDTH shift
      const x = isA 
        ? TABLE_WIDTH + (currentPduColWidth - currentPduWidth) / 2
        : rackRightX + WIRE_GAP + ((currentPduColWidth - currentPduWidth) / 2);

      // Add TOP_OFFSET to y
      return { x, y: y + TOP_OFFSET, width: currentPduWidth, height: getPDUHeight(totalSockets) };
  };

  const getSocketPosition = (pdu: PDUConfig, socketIndex: number) => {
      const rect = getPDURect(pdu); // Base PDU rect
      
      const totalSockets = pdu.socketCount + (pdu.secondarySocketCount || 0);
      const socketsPerCircuit = Math.ceil(totalSockets / circuitCount);
      
      let currentY = PDU_HEADER_H + SOCKET_PADDING;
      const targetRow = Math.floor(socketIndex / pduCols);
      
      for(let r=0; r<targetRow; r++) {
           const firstS = r * pduCols;
           const isStart = (firstS === 0) || (firstS > 0 && firstS % socketsPerCircuit === 0);
           if (isStart) currentY += CIRCUIT_HEADER_HEIGHT + CIRCUIT_HEADER_MARGIN;
           
           currentY += SOCKET_H + SOCKET_GAP;
      }
      
      // Add header for target row if applicable
      const firstS = targetRow * pduCols;
      const isStart = (firstS === 0) || (firstS > 0 && firstS % socketsPerCircuit === 0);
      if (isStart) currentY += CIRCUIT_HEADER_HEIGHT + CIRCUIT_HEADER_MARGIN;

      // Y is centered in the socket height
      const y = rect.y + currentY + (SOCKET_H / 2);
      
      // X calculation
      const colIndex = socketIndex % pduCols;
      
      let xOffset = 0;
      if (pduCols === 2) {
          xOffset = colIndex === 0 ? -16 : 16; // 14px half width + 2px gap
      }
      const x = rect.x + (rect.width / 2) + xOffset;
      
      return { x, y };
  };

  // --- Drag & Drop (Unchanged logic) ---
  const handleDeviceDragStart = (e: React.DragEvent, device: Device) => {
    e.dataTransfer.setData('type', 'device');
    e.dataTransfer.setData('deviceId', device.id);
    e.dataTransfer.effectAllowed = 'move';
    setDraggedDevice(device.id);
  };

  const handleRackDragOver = (e: React.DragEvent) => {
    e.preventDefault(); 
    e.dataTransfer.dropEffect = 'move';
  };

  const handleRackDrop = (e: React.DragEvent, targetU: number) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('type');
    if (type !== 'device') return;
    const deviceId = e.dataTransfer.getData('deviceId');
    onMoveDevice(deviceId, targetU);
    setDraggedDevice(null);
  };

  const handleCableDragStart = (e: React.DragEvent, deviceId: string, psuIndex: number) => {
    e.stopPropagation(); 
    e.dataTransfer.setData('type', 'cable');
    e.dataTransfer.setData('deviceId', deviceId);
    e.dataTransfer.setData('psuIndex', psuIndex.toString());
    e.dataTransfer.effectAllowed = 'link';
    setDraggedCable({ deviceId, psuIndex });
  };

  const handleSocketDrop = (e: React.DragEvent, pduId: string, socketIndex: number, isOccupied: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setHoveredSocket(null);
    // Allow dropping on occupied sockets to trigger swap/replace logic in parent

    const type = e.dataTransfer.getData('type');
    if (type === 'cable') {
        const deviceId = e.dataTransfer.getData('deviceId');
        const psuIndex = parseInt(e.dataTransfer.getData('psuIndex'));
        onUpdateConnection(deviceId, psuIndex, pduId, socketIndex);
    }
    setDraggedCable(null);
  };

  const handleSocketDragOver = (e: React.DragEvent, pduId: string, index: number, isOccupied: boolean) => {
    e.preventDefault();
    // Allow hover even if occupied
    e.dataTransfer.dropEffect = 'link';
    setHoveredSocket({ pduId, index });
  };

  // --- Rendering ---

  const occupationMap = new Map<number, Device>();
  devices.forEach(d => {
    if (d.uPosition) {
      for (let i = 0; i < d.uHeight; i++) {
        occupationMap.set(d.uPosition - i, d);
      }
    }
  });

  const renderSummaryTable = () => {
    const totalMax = devices.reduce((s, d) => s + d.powerRatingPerDevice, 0);
    const totalTyp = devices.reduce((s, d) => s + d.typicalPower, 0);
    
    // Group loads by Pair Index
    const pairLoads: Record<number, { a: number, b: number }> = {};
    pdus.forEach(p => {
        if (!pairLoads[p.index]) pairLoads[p.index] = { a: 0, b: 0 };
        const load = pduLoads[p.id].max;
        if (p.side === 'A') pairLoads[p.index].a = load;
        else pairLoads[p.index].b = load;
    });

    const primaryPDU = pdus[0];
    const capacity = primaryPDU ? primaryPDU.powerCapacity : 0;

    // Calculate Input Amps (Estimate based on capacity and phase)
    let inputAmps = 0;
    
    if (isThreePhase) {
        // 400V Calculation
        inputAmps = Math.round(capacity / (Math.sqrt(3) * 400));
    } else {
        inputAmps = Math.round(capacity / 230);
    }

    // Determine Plug Type (Guess)
    let plugType = "Hardwired / Unknown";
    if (inputAmps <= 10) plugType = "C14 / NEMA 5-15";
    else if (inputAmps <= 16) plugType = isThreePhase ? "IEC 60309 16A Red (3P+N+E)" : "IEC 60309 16A Blue (2P+E) / C20";
    else if (inputAmps <= 32) plugType = isThreePhase ? "IEC 60309 32A Red (3P+N+E)" : "IEC 60309 32A Blue (2P+E)";
    else if (inputAmps <= 63) plugType = isThreePhase ? "IEC 60309 63A Red (3P+N+E)" : "IEC 60309 63A Blue (2P+E)";
    else plugType = "High Current / Busway";

    const inputVoltageLabel = isThreePhase ? '400V (3-Phase)' : '230V (1-Phase)';

    // UPS Calculation
    const requiredVA = (totalMax / powerFactor) * 1.25; // 25% Headroom
    const standardSizes = [1000, 1500, 2000, 2200, 3000, 5000, 6000, 8000, 10000, 15000, 20000, 30000, 40000, 50000];
    const recommendedSize = standardSizes.find(s => s >= requiredVA) || (Math.ceil(requiredVA / 10000) * 10000);

    return (
        <div 
            className="absolute top-0 left-0 h-full border-r border-slate-300 bg-slate-50 p-6 flex flex-col text-slate-900"
            style={{ width: TABLE_WIDTH }}
        >
            <h2 className="text-xl font-bold text-slate-800 mb-6 border-b border-slate-300 pb-2">Rack Summary</h2>
            
            <div className="space-y-6">
                
                {/* PDU Specifications */}
                <div>
                    <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-2">PDU Specs</h3>
                    
                    {/* Input Section */}
                    <div className="mb-4">
                        <div className="text-[10px] font-bold text-slate-400 uppercase mb-1 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 bg-blue-500 rounded-full"></span> Input
                        </div>
                        <table className="w-full text-xs text-left bg-white border border-slate-200 rounded overflow-hidden">
                            <tbody className="divide-y divide-slate-100">
                                <tr>
                                    <td className="p-1.5 pl-2 font-semibold text-slate-600">Feed</td>
                                    <td className="p-1.5 font-mono text-slate-800">{inputAmps}A</td>
                                </tr>
                                <tr>
                                    <td className="p-1.5 pl-2 font-semibold text-slate-600">Voltage</td>
                                    <td className="p-1.5 font-mono text-slate-800">{inputVoltageLabel}</td>
                                </tr>
                                <tr>
                                    <td className="p-1.5 pl-2 font-semibold text-slate-600">Plug</td>
                                    <td className="p-1.5 font-mono text-slate-800 truncate max-w-[140px]" title={plugType}>{plugType}</td>
                                </tr>
                                <tr>
                                    <td className="p-1.5 pl-2 font-semibold text-slate-600">Capacity</td>
                                    <td className="p-1.5 font-mono text-slate-800 font-bold">{(capacity / 1000).toFixed(1)} kW</td>
                                </tr>
                                <tr>
                                    <td className="p-1.5 pl-2 font-semibold text-slate-600">Cord</td>
                                    <td className="p-1.5 font-mono text-slate-800">{pduCordLength} m</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    {/* Output Section */}
                    <div>
                         <div className="text-[10px] font-bold text-slate-400 uppercase mb-1 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></span> Output
                        </div>
                        <table className="w-full text-xs text-left bg-white border border-slate-200 rounded overflow-hidden">
                            <tbody className="divide-y divide-slate-100">
                                <tr>
                                    <td className="p-1.5 pl-2 font-semibold text-slate-600">Voltage</td>
                                    <td className="p-1.5 font-mono text-slate-800">230V</td>
                                </tr>
                                <tr>
                                    <td className="p-1.5 pl-2 font-semibold text-slate-600">Breakers</td>
                                    <td className="p-1.5 font-mono text-slate-800">{circuitCount}x {circuitRating}A</td>
                                </tr>
                                <tr>
                                    <td className="p-1.5 pl-2 font-semibold text-slate-600">Form Factor</td>
                                    <td className="p-1.5 font-mono text-slate-800">{pduCols === 1 ? 'Single' : 'Double'} Col</td>
                                </tr>
                                 <tr>
                                    <td className="p-1.5 pl-2 font-semibold text-slate-600">Outlets</td>
                                    <td className="p-1.5 font-mono text-slate-800">
                                        {primaryPDU ? (
                                            <div className="flex flex-col gap-0.5">
                                                <span>{primaryPDU.socketCount}x {primaryPDU.socketType}</span>
                                                {primaryPDU.secondarySocketCount ? <span>{primaryPDU.secondarySocketCount}x {primaryPDU.secondarySocketType}</span> : null}
                                            </div>
                                        ) : '-'}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <div>
                    <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-2">Total Consumption</h3>
                    <div className="grid grid-cols-2 gap-4">
                        <div className="bg-white p-3 rounded border border-slate-200">
                            <div className="text-xs text-slate-500">Max Load</div>
                            <div className="text-lg font-mono font-bold text-slate-800">{Math.round(totalMax)}W</div>
                        </div>
                        <div className="bg-white p-3 rounded border border-slate-200">
                            <div className="text-xs text-slate-500">Typical</div>
                            <div className="text-lg font-mono font-bold text-emerald-600">{Math.round(totalTyp)}W</div>
                        </div>
                    </div>
                </div>

                <div>
                    <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-2">Device Count</h3>
                    <div className="bg-white p-3 rounded border border-slate-200">
                         <div className="text-3xl font-bold text-slate-800">{devices.length}</div>
                         <div className="text-xs text-slate-500">Rack Mounted Assets</div>
                    </div>
                </div>

                <div>
                    <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-2">PDU Load Balance</h3>
                    <table className="w-full text-xs text-left bg-white border border-slate-200 rounded overflow-hidden">
                        <thead className="bg-slate-100 text-slate-600">
                            <tr>
                                <th className="p-2 border-b">Pair</th>
                                <th className="p-2 border-b">Feed A</th>
                                <th className="p-2 border-b">Feed B</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {Object.entries(pairLoads).map(([idx, loads]) => {
                                const capacity = pdus.find(p => p.index === parseInt(idx))?.powerCapacity || 1;
                                const safeCap = capacity * powerFactor * (safetyMargin/100);
                                const isOverA = loads.a > safeCap;
                                const isOverB = loads.b > safeCap;

                                return (
                                    <tr key={idx}>
                                        <td className="p-2 font-mono text-slate-700">#{parseInt(idx)+1}</td>
                                        <td className={`p-2 font-mono ${isOverA ? 'text-red-600 font-bold' : 'text-slate-700'}`}>{Math.round(loads.a)}W</td>
                                        <td className={`p-2 font-mono ${isOverB ? 'text-red-600 font-bold' : 'text-slate-700'}`}>{Math.round(loads.b)}W</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {/* UPS Recommendations */}
                <div>
                    <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-2">UPS Recommendation</h3>
                    <table className="w-full text-xs text-left bg-white border border-slate-200 rounded overflow-hidden">
                        <tbody className="divide-y divide-slate-100">
                             <tr>
                                <td className="p-2 font-semibold text-slate-600">Total Load (VA)</td>
                                <td className="p-2 font-mono text-slate-800">{Math.round(totalMax / powerFactor).toLocaleString()} VA</td>
                            </tr>
                            <tr>
                                <td className="p-2 font-semibold text-slate-600">Rec. Capacity (+25%)</td>
                                <td className="p-2 font-mono text-slate-800 font-bold">{Math.round(requiredVA).toLocaleString()} VA</td>
                            </tr>
                            <tr>
                                <td className="p-2 font-semibold text-slate-600">Standard Unit</td>
                                <td className="p-2 font-mono text-emerald-600 font-bold">{recommendedSize.toLocaleString()} VA</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <div className="mt-auto pt-8 text-xs text-slate-400">
                    <p>Generated by PDU Planner</p>
                    <p>{new Date().toLocaleDateString()}</p>
                </div>
            </div>
        </div>
    );
  };

  const renderRack = () => {
    const slots = [];
    for (let u = rackSize; u >= 1; u--) {
      const device = occupationMap.get(u);
      
      if (device && device.uPosition === u) {
        const heightPx = device.uHeight * U_HEIGHT_PX;
        const isDragging = draggedDevice === device.id;
        
        slots.push(
          <div 
            key={`u-${u}`} 
            draggable
            onDragStart={(e) => handleDeviceDragStart(e, device)}
            onDragOver={handleRackDragOver}
            onDrop={(e) => handleRackDrop(e, u)}
            className={`w-[calc(100%-12px)] mx-auto relative border ${THEME.deviceBorder} ${THEME.deviceBg} ${THEME.deviceHover} rounded-md transition-colors group flex items-center px-2 box-border cursor-grab active:cursor-grabbing shadow-sm ${isDragging ? 'opacity-50 dashed border-2 border-blue-500' : ''}`}
            style={{ height: `${heightPx - 2}px`, marginTop: '1px', marginBottom: '1px' }}
          >
            {/* Device Info */}
            <div className="flex-1 flex items-center gap-2 overflow-hidden pointer-events-none z-10 mr-2 min-w-0 h-full">
                <span className={`${THEME.textDim} font-mono text-[10px] w-5 shrink-0 text-right`}>{u}</span>
                <div className="flex items-center justify-between w-full overflow-hidden h-full pr-1">
                    <div className="flex items-center h-full min-w-0 overflow-hidden flex-1">
                        <span className={`text-xs ${THEME.text} font-bold truncate leading-tight`} title={device.name}>
                            {device.name}
                        </span>
                    </div>
                    <div className="flex gap-2 text-[10px] items-center shrink-0 ml-2 h-full">
                        <span className="text-blue-600 whitespace-nowrap leading-tight" title="Typical Power">
                            Typ:{Math.round(device.typicalPower)}
                        </span>
                        <span className="text-red-600 whitespace-nowrap leading-tight" title="Max Power">
                            Max:{Math.round(device.powerRatingPerDevice)}
                        </span>
                        <span className="border border-slate-300 px-1 rounded whitespace-nowrap text-[9px] h-5 flex items-center justify-center text-slate-500 bg-slate-100 min-w-[20px] leading-tight">
                            {device.uHeight}U
                        </span>
                    </div>
                </div>
            </div>

            {/* PSU Ports */}
            <div className="flex items-center gap-1 z-20 shrink-0">
                {Array.from({length: device.psuCount}).map((_, idx) => {
                    const isConnected = !!device.psuConnections[idx];
                    return (
                        <div 
                            key={`psu-${idx}`}
                            draggable
                            onDragStart={(e) => handleCableDragStart(e, device.id, idx)}
                            className={`w-5 h-5 rounded flex items-center justify-center cursor-pointer hover:scale-110 transition-transform ${isConnected ? 'bg-emerald-600 text-white' : 'bg-slate-300 text-slate-500'}`}
                            title={`PSU #${idx+1} - Drag to PDU`}
                        >
                            <Plug size={10} />
                        </div>
                    );
                })}
            </div>
          </div>
        );
        u = u - device.uHeight + 1;
      } 
      else if (!device) {
        slots.push(
          <div 
            key={`u-${u}`} 
            onDragOver={handleRackDragOver}
            onDrop={(e) => handleRackDrop(e, u)}
            className="w-full border-b border-slate-700 flex items-center px-2 hover:bg-slate-700/50 transition-colors"
            style={{ height: `${U_HEIGHT_PX}px` }}
          >
            <span className="text-slate-500 font-mono text-[10px] w-6 select-none">{u}</span>
            <div className="w-full h-full flex items-center justify-center opacity-0 hover:opacity-100">
                 <div className="w-full h-px border-t border-dashed border-slate-500"></div>
            </div>
          </div>
        );
      }
    }
    return slots;
  };

  const renderSocket = (pdu: PDUConfig, index: number, circuitIdx: number, isCircuitOverloaded: boolean, isLast: boolean, colIndex: number = 0) => {
      let connectedDevice: Device | undefined;
      let connectedPsuIndex: number = -1;

      for (const d of devices) {
        Object.entries(d.psuConnections).forEach(([key, val]) => {
            const conn = val as PSUConnection | null;
            if (conn && conn.pduId === pdu.id && conn.socketIndex === index) {
                connectedDevice = d;
                connectedPsuIndex = parseInt(key);
            }
        });
        if (connectedDevice) break;
      }
      
      const isOccupied = !!connectedDevice;
      const isHovered = hoveredSocket?.pduId === pdu.id && hoveredSocket?.index === index;
      
      const isSecondary = index >= pdu.socketCount;
      const currentType = isSecondary ? (pdu.secondarySocketType || 'C19') : pdu.socketType;

      return (
        <div 
            key={`${pdu.id}-${index}`}
            draggable={isOccupied}
            onDragStart={(e) => {
                if (isOccupied && connectedDevice) {
                    handleCableDragStart(e, connectedDevice.id, connectedPsuIndex);
                }
            }}
            onDragOver={(e) => handleSocketDragOver(e, pdu.id, index, isOccupied)}
            onDragLeave={() => setHoveredSocket(null)}
            onDrop={(e) => handleSocketDrop(e, pdu.id, index, isOccupied)}
            className={`flex items-center flex-shrink-0 relative ${isOccupied ? 'cursor-grab active:cursor-grabbing' : ''} ${isCircuitOverloaded ? 'bg-red-900/10 rounded px-1 -mx-1' : ''}`}
            style={{ marginBottom: 0 }} // Managed by parent row
        >
           {/* Circuit Warning Marker */}
           {isCircuitOverloaded && <div className="absolute -left-2 top-1 w-1 h-1 bg-red-500 rounded-full"></div>}
           <SocketIcon 
               type={currentType} 
               used={isOccupied} 
               label={`${index+1}`} 
               hovered={isHovered} 
               labelSide={colIndex === 1 ? 'right' : 'left'}
           />
        </div>
      );
  };

  const renderCables = () => {
    const lines = [];
    const sortedDevices = [...devices].filter(d => d.uPosition).sort((a, b) => (b.uPosition || 0) - (a.uPosition || 0));

    sortedDevices.forEach(d => {
        if (!d.uPosition) return;

        const uTopY = (rackSize - d.uPosition) * U_HEIGHT_PX;
        const deviceCenterY = RACK_HEADER_HEIGHT + uTopY + (d.uHeight * U_HEIGHT_PX / 2) + TOP_OFFSET;

        Object.entries(d.psuConnections).forEach(([psuIdxStr, c]) => {
            const conn = c as PSUConnection | null;
            if (!conn) return;

            const pdu = pdus.find(p => p.id === conn.pduId);
            if (!pdu) return;

            // Use updated logic for exact coordinates
            const socketPos = getSocketPosition(pdu, conn.socketIndex);
            const socketY = socketPos.y;
            const pduCenterX = socketPos.x;
            
            const deviceX = pdu.side === 'A' ? rackLeftX : rackRightX;
            const dist = Math.abs(deviceX - pduCenterX);
            const cp1X = deviceX + (pdu.side === 'A' ? -dist * 0.5 : dist * 0.5);
            const cp2X = pduCenterX; 

            const color = pdu.side === 'A' ? '#3b82f6' : '#ef4444';

            lines.push(
                <path 
                   key={`cable-${d.id}-${psuIdxStr}`}
                   d={`M ${deviceX} ${deviceCenterY} C ${cp1X} ${deviceCenterY}, ${cp2X} ${socketY}, ${pduCenterX} ${socketY}`}
                   fill="none"
                   stroke={color}
                   strokeWidth="2"
                   strokeOpacity="0.8"
                   className="hover:stroke-[3px] hover:stroke-opacity-100 transition-all pointer-events-auto"
                   onClick={() => onUpdateConnection(d.id, parseInt(psuIdxStr), null, null)}
                />
            );
            
            lines.push(<circle key={`d1-${d.id}-${psuIdxStr}`} cx={deviceX} cy={deviceCenterY} r="3" fill={color} />);
            lines.push(<circle key={`d2-${d.id}-${psuIdxStr}`} cx={pduCenterX} cy={socketY} r="3" fill={color} />);
        });
    });

    return (
        <svg className="absolute inset-0 w-full h-full pointer-events-none z-50" width={totalWidth} height={containerHeight}>
            {lines}
        </svg>
    );
  };

  const pduHeightA = getGroupTotalHeight(pdusA);
  const pduHeightB = getGroupTotalHeight(pdusB);
  const maxContentHeight = Math.max(rackHeightPx, pduHeightA, pduHeightB);

  const containerHeight = Math.max(
      maxContentHeight + TOP_OFFSET + 100, 
      (unmountedDevices.length > 0 ? rackHeightPx + 400 : rackHeightPx + 200)
  );

  return (
    <div 
        className={`relative ${THEME.bg} ${THEME.text} rounded-xl border ${THEME.border} select-none my-8 overflow-hidden`}
        style={{ width: totalWidth, height: containerHeight }} 
    >
      
      {/* Summary Table on Left */}
      {renderSummaryTable()}

      {/* Rack Name Header */}
      <div 
        className="absolute z-10 text-center"
        style={{ 
            top: 20, 
            left: rackLeftX, 
            width: RACK_WIDTH,
        }}
      >
          <h2 className="text-2xl font-bold text-slate-800 uppercase tracking-tight">
              {devices[0]?.room || 'Rack Layout'}
          </h2>
      </div>

      {/* Render PDUs */}
      {pdus.map(pdu => {
          const rect = getPDURect(pdu);
          const load = pduLoads[pdu.id];
          const effectiveCap = pdu.powerCapacity * powerFactor * (safetyMargin / 100);
          const isOverloaded = load.max > effectiveCap;
          const pct = Math.min(100, (load.max / pdu.powerCapacity) * 100);

          const totalSockets = pdu.socketCount + (pdu.secondarySocketCount || 0);
          const socketsPerCircuit = Math.ceil(totalSockets / circuitCount);
          
          // Calculate Circuit Loads
          const circuitLoads: number[] = new Array(circuitCount).fill(0);
          
          devices.forEach(d => {
             Object.entries(d.psuConnections).forEach(([key, val]) => {
                const conn = val as PSUConnection | null;
                if (conn && conn.pduId === pdu.id) {
                     // Determine circuit
                     const cIdx = Math.floor(conn.socketIndex / socketsPerCircuit);
                     if (cIdx < circuitCount) {
                         circuitLoads[cIdx] += d.powerRatingPerDevice;
                     }
                }
             });
          });

          // Calculate total rows needed
          const rows = Math.ceil(totalSockets / pduCols);

          return (
            <React.Fragment key={pdu.id}>
                <div 
                    className="absolute flex flex-col z-10"
                    style={{ 
                        left: rect.x, 
                        top: rect.y,
                        width: rect.width, 
                        height: rect.height
                    }}
                >
                    <div className={`w-full flex flex-col items-center bg-slate-900 border ${isOverloaded ? 'border-red-500' : 'border-slate-700'} rounded-lg h-full shadow-sm`}>
                        {/* Header */}
                        <div 
                            className={`shrink-0 w-full flex flex-col items-center justify-center text-[10px] font-bold ${pdu.side === 'A' ? 'text-blue-400' : 'text-red-400'} border-b border-slate-700`}
                            style={{ height: PDU_HEADER_H }}
                        >
                            <Zap size={12} fill="currentColor" />
                            <span>{pdu.id}</span>
                        </div>
                        
                        {/* Sockets Container */}
                        <div className="flex-1 w-full flex flex-col items-center relative" style={{ padding: `${SOCKET_PADDING}px 0` }}>
                            {Array.from({ length: rows }).map((_, rIdx) => {
                                const firstSIdx = rIdx * pduCols;
                                const cIdx = Math.floor(firstSIdx / socketsPerCircuit);
                                
                                // Determine if this row starts a circuit section
                                const isStartOfCircuit = (firstSIdx === 0) || (firstSIdx > 0 && firstSIdx % socketsPerCircuit === 0);

                                const cLoadWatts = circuitLoads[cIdx] || 0;
                                const cAmps = (cLoadWatts / powerFactor) / voltage;
                                const label = isThreePhase ? `L${(cIdx % 3) + 1}` : `C${cIdx + 1}`;
                                const cPct = Math.min(100, (cAmps / circuitRating) * 100);
                                const barColor = cAmps > circuitRating ? 'bg-red-500' : (cPct > 80 ? 'bg-amber-500' : 'bg-emerald-500');

                                // Gather sockets for this row
                                const rowSockets = [];
                                for (let c = 0; c < pduCols; c++) {
                                    const sIdx = firstSIdx + c;
                                    if (sIdx < totalSockets) {
                                        const sCIdx = Math.floor(sIdx / socketsPerCircuit);
                                        const sCLoadWatts = circuitLoads[sCIdx] || 0;
                                        const sCAmps = (sCLoadWatts / powerFactor) / voltage;
                                        const isCOver = sCAmps > circuitRating;
                                        rowSockets.push({ idx: sIdx, cIdx: sCIdx, isOver: isCOver });
                                    }
                                }

                                return (
                                    <React.Fragment key={rIdx}>
                                        {isStartOfCircuit && (
                                            <div 
                                                className="w-full mb-1 flex flex-col justify-center bg-slate-900 border-y border-slate-700 relative overflow-hidden shrink-0" 
                                                style={{ height: `${CIRCUIT_HEADER_HEIGHT}px` }}
                                            >
                                                {/* Text Info */}
                                                <div className="w-full flex justify-between px-1.5 items-center relative z-10 h-full pb-[2px]">
                                                    <span className="text-[8px] font-bold text-slate-300">{label}</span>
                                                    <div className={`text-[7px] font-mono ${cAmps > circuitRating ? 'text-red-400 font-bold' : 'text-slate-400'}`}>
                                                        {Math.round(cLoadWatts)}W
                                                    </div>
                                                </div>
                                                
                                                {/* Progress Bar */}
                                                <div className="absolute bottom-0 left-0 w-full h-[2px] bg-slate-800">
                                                    <div className={`h-full transition-all duration-300 ${barColor}`} style={{ width: `${cPct}%` }}></div>
                                                </div>
                                            </div>
                                        )}
                                        
                                        {/* Socket Row */}
                                        <div 
                                            className="w-full flex justify-center gap-1 shrink-0"
                                            style={{ height: SOCKET_H, marginBottom: rIdx < rows - 1 ? SOCKET_GAP : 0 }}
                                        >
                                            {rowSockets.map((s, cIdx) => (
                                                renderSocket(pdu, s.idx, s.cIdx, s.isOver, false, cIdx)
                                            ))}
                                        </div>
                                    </React.Fragment>
                                );
                            })}
                        </div>
                        
                        {/* Footer / Load Bar */}
                        <div 
                            className="shrink-0 w-full p-1 flex flex-col justify-end border-t border-slate-700"
                            style={{ height: PDU_FOOTER_H }}
                        >
                            <div className="w-full h-1 bg-slate-700 rounded-full overflow-hidden mb-1">
                                <div className={`h-full ${isOverloaded ? 'bg-red-500' : (pdu.side === 'A' ? 'bg-blue-500' : 'bg-red-500')}`} style={{ width: `${pct}%` }}></div>
                            </div>
                            <div className={`text-[9px] text-center ${isOverloaded ? 'text-red-400' : 'text-slate-400'}`}>{Math.round(load.max)}W</div>
                            
                            {/* Circuit Check Tooltip Logic could go here, but purely visual for now */}
                            {circuitLoads.some(l => ((l/powerFactor)/voltage) > circuitRating) && (
                                <div className="text-[8px] text-center text-red-500 font-bold bg-slate-800 rounded px-1 absolute -bottom-4 w-full">
                                    Breaker!
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </React.Fragment>
          );
      })}

      {/* Render Rack */}
      <div 
        className={`absolute w-[420px] ${THEME.rackBg} border-x-4 ${THEME.rackBorder} z-20 flex flex-col shadow-lg`}
        style={{ left: rackLeftX, height: rackHeightPx, top: TOP_OFFSET }}
      >
         <div className="h-4 shrink-0 bg-slate-900 w-full border-b border-slate-700"></div>
         
         {/* Rack Rails - Moved Here */}
         <div className="absolute left-1 top-0 bottom-0 w-1 bg-black/50 z-10 pointer-events-none"></div>
         <div className="absolute right-1 top-0 bottom-0 w-1 bg-black/50 z-10 pointer-events-none"></div>

         <div className="flex-1 flex flex-col w-full relative z-20">
             {renderRack()}
         </div>
         <div className="h-4 shrink-0 bg-slate-900 w-full border-t border-slate-700"></div>
      </div>
      
      {/* Unmounted Devices Section */}
      {unmountedDevices.length > 0 && (
          <div 
             className="absolute bg-slate-100 border border-slate-300 rounded-lg p-4 z-20 shadow-md flex flex-col gap-2"
             style={{ 
                left: rackLeftX, 
                top: rackHeightPx + TOP_OFFSET + 40,
                width: RACK_WIDTH 
             }}
          >
             <h3 className="font-bold text-slate-700 text-sm flex items-center gap-2">
                <AlertTriangle size={14} className="text-amber-500"/>
                Unmounted Devices ({unmountedDevices.length})
             </h3>
             <div className="max-h-48 overflow-y-auto pr-2 space-y-1">
                 {unmountedDevices.map(d => (
                     <div key={d.id} className="bg-white border border-slate-200 p-2 rounded text-xs flex justify-between items-center">
                        <span className="font-semibold text-slate-800 truncate max-w-[180px]" title={d.name}>{d.name}</span>
                        <span className="text-slate-500 font-mono">{d.powerRatingPerDevice}W | {d.uHeight}U</span>
                     </div>
                 ))}
             </div>
             <p className="text-[10px] text-slate-400">Not enough U space to mount automatically.</p>
          </div>
      )}
      
      {/* Render Cables Last (Top Layer) */}
      {renderCables()}

    </div>
  );
};

export default RackVisualizer;
