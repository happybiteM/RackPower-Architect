
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { parseCSV } from '../utils/csvParser';
import { DEFAULT_CSV, PDU_VARIANTS } from '../constants';
import RackVisualizer from './RackVisualizer';
import { Device, PSUConnection, SocketType, PDUConfig, PduType, PhysicalDimensions, RACK_SIZES, CORD_BEND_CM, PduPlacementStrategy, MountSide, PduFormFactor, ManualPlacementMap, VerticalPlacementMap, VerticalChannel, PduInletType, INLET_MAX_AMPS, INLET_WIRE_MM2 } from '../types';
import { calculatePduPlacement, DEFAULT_DEVICE_DIM, pduRequiredU } from '../utils/placement';
import RackSideView from './RackSideView';
import { Upload, Settings, Printer, BatteryCharging, Edit3, Save, RotateCcw, Download, FileImage, FileText, FileCode, RefreshCw, FileJson, Plus, Minus, Zap, Sun, Moon, LayoutDashboard, Boxes, ClipboardList, AlertTriangle } from 'lucide-react';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import DOMPurify from 'dompurify';
import { toast } from 'react-toastify';
import { useTheme } from '../utils/theme';

type TabId = 'config' | 'wiring' | 'reports';

const TAB_STORAGE_KEY = 'rack-planner-active-tab';

// --- Geometry Constants (Must match RackVisualizer) ---
const U_HEIGHT_PX = 30; 
const RACK_HEADER_HEIGHT = 16;

const PDU_HEADER_H = 40;
const PDU_FOOTER_H = 40;
const SOCKET_H = 14; 
const SOCKET_GAP = 4;
const SOCKET_PADDING = 8;
const PDU_VERTICAL_GAP = 20;


const withMountDefaults = (list: Device[]): Device[] =>
  list.map(d => ({ ...d, mountSide: d.mountSide ?? 'front' }));

const Dashboard: React.FC = () => {
  const [csvInput, setCsvInput] = useState(DEFAULT_CSV);
  
  // Active Room State
  const [activeDevices, setActiveDevices] = useState<Device[]>([]);

  // Configuration
  const [rackSize, setRackSize] = useState(48);
  const [tempRackSize, setTempRackSize] = useState<number | string>(48);

  const [manualPduPairs, setManualPduPairs] = useState<number | null>(null);

  // NOTE: PDU electrical parameters (sockets, capacity, inlet/supply, breaker,
  // dimensions, columns, form factor, mount rail) live in the PDU Library
  // section of Global Config — it is the single source of truth that both
  // diagrams draw from.
  const [pduCordLength, setPduCordLength] = useState<number>(3); // meters

  // Rack & placement configuration
  const [rackPreset, setRackPreset] = useState<string>('48U');
  const [rackDepth, setRackDepth] = useState<number>(120); // cm (external)
  const [placementStrategy, setPlacementStrategy] = useState<PduPlacementStrategy>('bottom');
  const [deviceDims, setDeviceDims] = useState<Record<string, PhysicalDimensions>>({});
  // Side-view manual placements
  const [manualPlacements, setManualPlacements] = useState<ManualPlacementMap>({});
  const [verticalPlacements, setVerticalPlacements] = useState<VerticalPlacementMap>({});

  // --- PDU Library: PDUs are treated like devices — user defines types -------
  // Each type has parameters (form factor, sockets, dims) and a quantity.
  // Vertical & horizontal rack PDUs share the same power rating config.
  const [pduLibrary, setPduLibrary] = useState<PduType[]>(() => ([
    {
      id: 'vertA', name: 'Vertical 0U · C13 x20', formFactor: 'vertical',
      socketType: 'C13', socketCount: 20, secondarySocketType: 'C19', secondarySocketCount: 4,
      powerCapacity: 7360, inletType: 'IEC-309-32A', supplyVoltage: 230, ratedCurrent: 32,
      isThreePhase: false, circuitCount: 2, breakerRatingA: 16,
      physicalHeightCm: 183, uHeight: 0, physicalWidthCm: 5.6, physicalDepthCm: 5.6, cols: 1, mountSide: 'back', quantity: 2,
    },
    {
      id: 'horiz1U', name: 'Horizontal 1U · C13 x8', formFactor: 'horizontal',
      socketType: 'C13', socketCount: 8, secondarySocketType: undefined, secondarySocketCount: 0,
      powerCapacity: 7360, inletType: 'C20', supplyVoltage: 230, ratedCurrent: 20,
      isThreePhase: false, circuitCount: 2, breakerRatingA: 16,
      physicalHeightCm: 0, uHeight: 1, physicalWidthCm: 48.3, physicalDepthCm: 7.5, cols: 1, mountSide: 'back', quantity: 0,
    },
  ]));

  const [safetyMargin, setSafetyMargin] = useState(80);
  const [powerFactor, setPowerFactor] = useState(0.95);
  
  // Group Editing State
  const [editGroupModalOpen, setEditGroupModalOpen] = useState(false);
  const [deviceTypes, setDeviceTypes] = useState<string[]>([]);
  const [editingType, setEditingType] = useState<string>('');
  const [editValues, setEditValues] = useState({ uHeight: 1, typical: 0, max: 0 });
  const [editDims, setEditDims] = useState<PhysicalDimensions>({ ...DEFAULT_DEVICE_DIM });

  // UI State
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    try {
      const t = localStorage.getItem(TAB_STORAGE_KEY);
      if (t === 'config' || t === 'wiring' || t === 'reports') return t;
    } catch { /* ignore */ }
    return 'wiring';
  });
  useEffect(() => {
    try { localStorage.setItem(TAB_STORAGE_KEY, activeTab); } catch { /* ignore */ }
  }, [activeTab]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const configInputRef = useRef<HTMLInputElement>(null);
  const visualizerRef = useRef<HTMLDivElement>(null);

  // --- Derived PDU Specs: single source of truth = the PDU library (merged
  // into Global Config). Both diagrams (front RackVisualizer & side view) and
  // all electrical math draw from these per-type parameters. The "reference"
  // type is the first vertical type, else the first type in the library.
  const refPduType = useMemo<PduType | undefined>(() =>
    pduLibrary.find(t => t.formFactor === 'vertical' && t.quantity > 0)
      ?? pduLibrary.find(t => t.quantity > 0)
      ?? pduLibrary[0],
  [pduLibrary]);

  const pduSpecs = useMemo(() => {
    if (refPduType) {
      return {
        voltage: refPduType.supplyVoltage,
        circuits: refPduType.circuitCount,
        amps: refPduType.breakerRatingA,
        isThreePhase: refPduType.isThreePhase,
      };
    }
    return { voltage: 230, circuits: 1, amps: 32, isThreePhase: false };
  }, [refPduType]);

  // Primary/secondary socket counts & types now come from the reference PDU type.
  const baseSocketsPerPDU = refPduType?.socketCount ?? 8;
  const secondarySocketsPerPDU = refPduType?.secondarySocketCount ?? 0;
  const socketType = refPduType?.socketType ?? 'C13';
  const secondarySocketType: SocketType = refPduType?.secondarySocketType ?? 'C19';

  // Per-type power capacity is the single source of truth; fall back to the
  // legacy PDU_VARIANTS default when no type is defined yet.
  const basePduCapacity = refPduType?.powerCapacity ?? 7360;

  // Placement inputs derived from the library (both diagrams consume these):
  const pduVertSpaceU = 0;                                   // always auto from per-PDU physical height
  const pduInletType: keyof typeof CORD_BEND_CM = refPduType?.inletType ?? 'C14';
  const pduPhysicalHeight = refPduType?.physicalHeightCm ?? 18;   // cm — body height/strip length
  const pduPhysicalWidth = refPduType?.physicalWidthCm ?? 5.5;    // cm — faceplate width
  /** Socket columns on the face of a horizontal PDU (drives diagram layout). */
  const pduCols = Math.max(1, Math.min(2, Math.round(pduPhysicalWidth / 24)));
  const horizontalDepthCm =
    pduLibrary.find(t => t.formFactor === 'horizontal' && t.quantity > 0)?.physicalDepthCm
    ?? refPduType?.physicalDepthCm ?? 7.5;

  // --- Logic to Calculate Required PDUs ---
  
  const calculatedPduPairs = useMemo(() => {
    const totalMaxPower = activeDevices.reduce((sum, d) => sum + d.powerRatingPerDevice, 0);
    const totalPSUs = activeDevices.reduce((sum, d) => sum + d.psuCount, 0);
    
    // Effective capacity per side (A or B) taking redundancy into account.
    const effectiveCapacity = basePduCapacity * powerFactor * (safetyMargin / 100);
    
    // Power Requirement (Ceil) - Removed buffer
    const pairsByPower = Math.ceil(totalMaxPower / effectiveCapacity);
    
    // Socket Requirement (Total sockets = base + secondary)
    const totalSocketsPerPDU = baseSocketsPerPDU + secondarySocketsPerPDU;
    const pairsBySockets = Math.ceil((totalPSUs / 2) / totalSocketsPerPDU);
    
    return Math.max(1, pairsByPower, pairsBySockets);
  }, [activeDevices, basePduCapacity, powerFactor, safetyMargin, baseSocketsPerPDU, secondarySocketsPerPDU]);

  const activePduPairs = manualPduPairs !== null ? manualPduPairs : calculatedPduPairs;

  // --- PDU Library helpers ----------------------------------------------------
  // PDUs are treated like devices: the user defines PDU *types* (parameters +
  // quantity) in a dedicated section, and instances are stamped from them.
  const pduSeqRef = useRef(1);
  const nextPduTypeId = () => `pduType${pduSeqRef.current++}`;

  const makeDefaultPduType = (): PduType => ({
    id: nextPduTypeId(),
    name: 'New PDU Type',
    formFactor: 'vertical',
    socketType: 'C13',
    socketCount: 20,
    secondarySocketType: 'C19',
    secondarySocketCount: 4,
    powerCapacity: basePduCapacity,
    inletType: 'IEC-309-32A',
    supplyVoltage: pduSpecs.voltage,
    ratedCurrent: 32,
    isThreePhase: false,
    circuitCount: pduSpecs.circuits,
    breakerRatingA: 16,
    physicalHeightCm: 183,
    uHeight: 1,
    physicalWidthCm: 5.6,
    physicalDepthCm: 5.6,
    cols: 1,
    mountSide: 'back',
    quantity: 1,
  });

  const updatePduType = (id: string, patch: Partial<PduType>) => {
    setPduLibrary(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  };

  const addPduType = () => {
    setPduLibrary(prev => [...prev, makeDefaultPduType()]);
  };

  const removePduType = (id: string) => {
    setPduLibrary(prev => prev.filter(t => t.id !== id));
    // Drop placements referencing instances that no longer exist is handled
    // automatically by placement recompute; stale keys are harmless.
  };

  // Expand the PDU library into concrete instances (qty × type), like devices.
  // Instances alternate between Feed A and Feed B so redundancy pairs stay balanced.
  const pduInstances: PDUConfig[] = useMemo(() => {
    const list: PDUConfig[] = [];
    let aCount = 0, bCount = 0;
    for (const t of pduLibrary) {
      for (let q = 0; q < Math.max(0, Math.floor(t.quantity)); q++) {
        const side: 'A' | 'B' = aCount <= bCount ? 'A' : 'B';
        if (side === 'A') aCount++; else bCount++;
        list.push({
          id: `${side}${side === 'A' ? aCount : bCount}`,
          side,
          index: (side === 'A' ? aCount : bCount) - 1,
          socketType: t.socketType,
          socketCount: Math.max(1, t.socketCount),
          secondarySocketType: t.secondarySocketType,
          secondarySocketCount: t.secondarySocketCount ?? 0,
          powerCapacity: t.powerCapacity,   // per-type power rating config
          inletType: t.inletType,
          supplyVoltage: t.supplyVoltage,
          ratedCurrent: t.ratedCurrent,
          isThreePhase: t.isThreePhase,
          circuitCount: t.circuitCount,
          breakerRatingA: t.breakerRatingA,
          formFactor: t.formFactor,
          physicalHeightCm: t.formFactor === 'vertical' ? t.physicalHeightCm : 0,
          uHeight: t.formFactor === 'horizontal' ? Math.max(1, Math.round(t.uHeight || 1)) : 0,
          physicalDepthCm: t.physicalDepthCm,
          mountSide: t.formFactor === 'horizontal' ? t.mountSide : 'back',
          uPosition: null,
        });
      }
    }
    return list;
  }, [pduLibrary]);

  const pduAvailablePairs = Math.min(
    pduInstances.filter(p => p.side === 'A').length,
    pduInstances.filter(p => p.side === 'B').length,
  );

  // Effective PDU list comes ONLY from the PDU library section of Global
  // Config — both diagrams draw their data from it. When the library cannot
  // cover the required A/B pairs, pad with copies of the last-defined type so
  // wiring math stays consistent.
  const pdus: PDUConfig[] = useMemo(() => {
    const neededPairs = Math.max(activePduPairs, 1);
    if (pduInstances.length === 0) return [];
    if (pduAvailablePairs >= neededPairs) return pduInstances;
    const out = [...pduInstances];
    let aCount = out.filter(p => p.side === 'A').length;
    let bCount = out.filter(p => p.side === 'B').length;
    const template = pduLibrary[pduLibrary.length - 1];
    while (template && Math.min(aCount, bCount) < neededPairs) {
      const growA = aCount <= bCount;
      const idx = growA ? ++aCount : ++bCount;
      out.push({
        id: `${growA ? 'A' : 'B'}${idx}`,
        side: growA ? 'A' : 'B',
        index: idx - 1,
        socketType: template.socketType,
        socketCount: Math.max(1, template.socketCount),
        secondarySocketType: template.secondarySocketType,
        secondarySocketCount: template.secondarySocketCount ?? 0,
        powerCapacity: template.powerCapacity,
        inletType: template.inletType,
        supplyVoltage: template.supplyVoltage,
        ratedCurrent: template.ratedCurrent,
        isThreePhase: template.isThreePhase,
        circuitCount: template.circuitCount,
        breakerRatingA: template.breakerRatingA,
        formFactor: template.formFactor,
        physicalHeightCm: template.formFactor === 'vertical' ? template.physicalHeightCm : 0,
        uHeight: template.formFactor === 'horizontal' ? Math.max(1, Math.round(template.uHeight || 1)) : 0,
        physicalDepthCm: template.physicalDepthCm,
        mountSide: template.formFactor === 'horizontal' ? template.mountSide : 'back',
        uPosition: null,
      });
    }
    return out;
  }, [activePduPairs, pduInstances, pduAvailablePairs, pduLibrary]);

  // Helper: Get geometric Y position of a socket on a PDU
  // Used to find closest socket to device
  const getPDUSocketY = (
      pduIndex: number, 
      socketIndex: number, 
      numPairs: number, 
      totalSocketsPerPDU: number, 
      rackSizeU: number,
      cols: number,
      circuits: number
  ) => {
      const socketsPerCircuit = Math.ceil(totalSocketsPerPDU / circuits);
      const rows = Math.ceil(totalSocketsPerPDU / cols);

      const getPDUHeight = () => {
          let h = PDU_HEADER_H + SOCKET_PADDING;
          for(let r=0; r<rows; r++) {
              const firstS = r * cols;
              // Matches Visualizer Logic for headers
              const isStart = (firstS === 0) || (firstS > 0 && firstS % socketsPerCircuit === 0);
              if (isStart) h += 24; // Header (20) + Margin (4)
              h += SOCKET_H;
              if (r < rows - 1) h += SOCKET_GAP;
          }
          h += SOCKET_PADDING + PDU_FOOTER_H;
          return h;
      };

      const singlePduHeight = getPDUHeight();
      const totalGroupHeight = (numPairs * singlePduHeight) + ((numPairs - 1) * PDU_VERTICAL_GAP);
      
      const rackHeightPx = (rackSizeU * U_HEIGHT_PX) + (RACK_HEADER_HEIGHT * 2);
      const startY = Math.max(0, (rackHeightPx - totalGroupHeight) / 2);

      const pduTopY = startY + pduIndex * (singlePduHeight + PDU_VERTICAL_GAP);
      
      // Calculate specific row Y
      let currentY = PDU_HEADER_H + SOCKET_PADDING;
      const targetRow = Math.floor(socketIndex / cols);
      
      for(let r=0; r<targetRow; r++) {
           const firstS = r * cols;
           const isStart = (firstS === 0) || (firstS > 0 && firstS % socketsPerCircuit === 0);
           if (isStart) currentY += 24; // Header + Margin
           currentY += SOCKET_H + SOCKET_GAP;
      }
      
      // Add header for target row itself if applicable
      const firstS = targetRow * cols;
      const isStart = (firstS === 0) || (firstS > 0 && firstS % socketsPerCircuit === 0);
      if (isStart) currentY += 24;
      
      return pduTopY + currentY + (SOCKET_H / 2);
  };

  // Helper: Shared Logic for Auto-Wiring
  const runAutoConnect = (
    devicesToProcess: Device[], 
    pduState: Record<string, { 
        currentLoad: number, 
        usedSockets: Set<number>, 
        id: string, 
        index: number,
        circuitLoads: number[]
    }>,
    numPairs: number,
    effectiveCap: number,
    totalSocketsPerPDU: number,
    // Circuit Params
    voltage: number,
    circuitCount: number,
    circuitAmps: number,
    powerFactor: number,
    safetyMargin: number,
    cols: number
  ) => {
    
    const socketsPerCircuit = Math.ceil(totalSocketsPerPDU / circuitCount);
    // Effective Circuit Limit (Amps) with Safety Margin
    const effectiveCircuitAmps = circuitAmps * (safetyMargin / 100);

    const checkCircuit = (pdu: typeof pduState[string], socketIndex: number, loadWatts: number) => {
         const cIdx = Math.floor(socketIndex / socketsPerCircuit);
         if (cIdx >= circuitCount) return false; 
         
         const currentWatts = pdu.circuitLoads[cIdx] || 0;
         const totalWatts = currentWatts + loadWatts;
         // VA = Watts / PF; Amps = VA / Volts
         const totalAmps = (totalWatts / powerFactor) / voltage;
         
         return totalAmps <= effectiveCircuitAmps;
    };

    const addCircuitLoad = (pdu: typeof pduState[string], socketIndex: number, loadWatts: number) => {
        const cIdx = Math.floor(socketIndex / socketsPerCircuit);
        if (cIdx < circuitCount) {
             pdu.circuitLoads[cIdx] = (pdu.circuitLoads[cIdx] || 0) + loadWatts;
        }
    };

    // Sort devices by U Position (Descending)
    const sortedDevices = [...devicesToProcess].sort((a, b) => {
        if (!a.uPosition && !b.uPosition) return 0;
        if (!a.uPosition) return 1;
        if (!b.uPosition) return -1;
        return b.uPosition - a.uPosition;
    });

    // Separation: Dual PSU vs Single/Other
    const dualPSUDevices = sortedDevices.filter(d => d.psuCount === 2);
    const otherDevices = sortedDevices.filter(d => d.psuCount !== 2);

    const processedDevices: Device[] = [];

    // --- PHASE 1: DUAL PSU DEVICES (Try to match sockets on A & B) ---
    for (const d of dualPSUDevices) {
        if (!d.uPosition) {
            processedDevices.push({ ...d, mountSide: d.mountSide ?? 'front', psuConnections: {} });
            continue;
        }

        const newConns: any = {};
        const uPos = d.uPosition; 
        const topPx = RACK_HEADER_HEIGHT + ((rackSize - uPos) * U_HEIGHT_PX);
        const deviceCenterY = topPx + ((d.uHeight * U_HEIGHT_PX) / 2);
        const loadToAdd = d.powerRatingPerDevice; 

        // Try to find a matched pair (A1+B1, A2+B2...)
        let assigned = false;
        
        // Iterate PDU Pairs (0, 1, 2...)
        for (let k = 0; k < numPairs; k++) {
            const pduA = pduState[`A${k+1}`];
            const pduB = pduState[`B${k+1}`];

            if (pduA.currentLoad + loadToAdd <= effectiveCap && pduB.currentLoad + loadToAdd <= effectiveCap) {
                // Find best shared socket index
                let bestSocket = -1;
                let shortestDist = Infinity;

                for (let s = 0; s < totalSocketsPerPDU; s++) {
                    // Must be free on BOTH
                    if (!pduA.usedSockets.has(s) && !pduB.usedSockets.has(s)) {
                         // Check Type
                         const isSecondary = s >= baseSocketsPerPDU;
                         const currentSocketType = isSecondary ? secondarySocketType : socketType;
                         if (currentSocketType !== d.connectionType) continue;

                         // Check Circuit Limits
                         if (!checkCircuit(pduA, s, loadToAdd) || !checkCircuit(pduB, s, loadToAdd)) continue;

                         const sY = getPDUSocketY(k, s, numPairs, totalSocketsPerPDU, rackSize, cols, pduSpecs.circuits);
                         const dist = Math.abs(sY - deviceCenterY);
                         
                         if (dist < shortestDist) {
                             shortestDist = dist;
                             bestSocket = s;
                         }
                    }
                }

                if (bestSocket !== -1) {
                    // Assign to Matched Pair
                    newConns[0] = { pduId: pduA.id, socketIndex: bestSocket };
                    newConns[1] = { pduId: pduB.id, socketIndex: bestSocket };
                    
                    pduA.usedSockets.add(bestSocket);
                    pduA.currentLoad += loadToAdd;
                    addCircuitLoad(pduA, bestSocket, loadToAdd);

                    pduB.usedSockets.add(bestSocket);
                    pduB.currentLoad += loadToAdd; 
                    addCircuitLoad(pduB, bestSocket, loadToAdd);
                    
                    assigned = true;
                    break;
                }
            }
        }

        // Fallback: If no matched pair found, assign individually using standard logic
        if (!assigned) {
             for(let i=0; i<d.psuCount; i++) {
                // 0 -> A, 1 -> B
                const side = i === 0 ? 'A' : 'B';
                let socketAssigned = false;
                
                // Sort candidates by index
                const candidates = [];
                for(let k=0; k<numPairs; k++) candidates.push(pduState[`${side}${k+1}`]);
                candidates.sort((a,b) => a.index - b.index);

                for (const pdu of candidates) {
                    if (pdu.currentLoad + loadToAdd <= effectiveCap) {
                        let bestSocket = -1;
                        let shortestDist = Infinity;

                        for(let s=0; s < totalSocketsPerPDU; s++) {
                            if (!pdu.usedSockets.has(s)) {
                                 const isSecondary = s >= baseSocketsPerPDU;
                                 const currentSocketType = isSecondary ? secondarySocketType : socketType;
                                 if (currentSocketType !== d.connectionType) continue;
                                 
                                 if (!checkCircuit(pdu, s, loadToAdd)) continue;

                                 const sY = getPDUSocketY(pdu.index, s, numPairs, totalSocketsPerPDU, rackSize, cols, pduSpecs.circuits);
                                 const dist = Math.abs(sY - deviceCenterY);
                                 if (dist < shortestDist) {
                                     shortestDist = dist;
                                     bestSocket = s;
                                 }
                            }
                        }

                        if (bestSocket !== -1) {
                            newConns[i] = { pduId: pdu.id, socketIndex: bestSocket };
                            pdu.usedSockets.add(bestSocket);
                            pdu.currentLoad += loadToAdd;
                            addCircuitLoad(pdu, bestSocket, loadToAdd);
                            socketAssigned = true;
                            break;
                        }
                    }
                }
                if (!socketAssigned) newConns[i] = null;
             }
        }

        const updated = { ...d, psuConnections: newConns };
        processedDevices.push(updated);
    }

    // --- PHASE 2: SINGLE / ODD PSU DEVICES ---
    let singlePsuRoundRobin = 0;
    
    for (const d of otherDevices) {
        if (!d.uPosition) {
            processedDevices.push({ ...d, mountSide: d.mountSide ?? 'front', psuConnections: {} });
            continue;
        }

        const newConns: any = {};
        const uPos = d.uPosition; 
        const topPx = RACK_HEADER_HEIGHT + ((rackSize - uPos) * U_HEIGHT_PX);
        const deviceCenterY = topPx + ((d.uHeight * U_HEIGHT_PX) / 2);
        const loadToAdd = d.powerRatingPerDevice; 

        for(let i=0; i<d.psuCount; i++) {
            let side: 'A' | 'B';
            // Round robin for single, A/B for multi-odd
            if (d.psuCount === 1) {
                side = singlePsuRoundRobin % 2 === 0 ? 'A' : 'B';
                singlePsuRoundRobin++;
            } else {
                side = i % 2 === 0 ? 'A' : 'B';
            }
            
            const candidates = [];
            for(let k=0; k<numPairs; k++) {
                candidates.push(pduState[`${side}${k+1}`]);
            }
            candidates.sort((a, b) => a.index - b.index);
            
            let assigned = false;
            for (const pdu of candidates) {
                if (pdu.currentLoad + loadToAdd <= effectiveCap) {
                      let bestSocket = -1;
                      let shortestDist = Infinity;

                      for(let s=0; s < totalSocketsPerPDU; s++) {
                          if (!pdu.usedSockets.has(s)) {
                               const isSecondary = s >= baseSocketsPerPDU;
                               const currentSocketType = isSecondary ? secondarySocketType : socketType;
                               if (currentSocketType !== d.connectionType) continue;

                               if (!checkCircuit(pdu, s, loadToAdd)) continue;

                               const sY = getPDUSocketY(pdu.index, s, numPairs, totalSocketsPerPDU, rackSize, cols, pduSpecs.circuits);
                               const dist = Math.abs(sY - deviceCenterY);
                               if (dist < shortestDist) {
                                   shortestDist = dist;
                                   bestSocket = s;
                               }
                          }
                      }

                      if (bestSocket !== -1) {
                          newConns[i] = { pduId: pdu.id, socketIndex: bestSocket };
                          pdu.usedSockets.add(bestSocket);
                          pdu.currentLoad += loadToAdd;
                          addCircuitLoad(pdu, bestSocket, loadToAdd);
                          assigned = true;
                          break;
                      }
                }
            }
            if (!assigned) newConns[i] = null;
        }
        
        const updated = { ...d, psuConnections: newConns };
        processedDevices.push(updated);
    }

    return processedDevices;
  };

  // Initial Load & Auto-Patching when CSV changes
  useEffect(() => {
  const processCSV = async () => {
    try {
      const groups = parseCSV(csvInput);
      if (groups.length > 0) {
        let devices = groups[0].devices;
        
        const effectiveCap = basePduCapacity * powerFactor * (safetyMargin / 100);
        const totalSocketsPerPDU = baseSocketsPerPDU + secondarySocketsPerPDU;

        const totalMaxPower = devices.reduce((sum, d) => sum + d.powerRatingPerDevice, 0);
        const totalPSUs = devices.reduce((sum, d) => sum + d.psuCount, 0);
        
        const pairsByPower = Math.ceil(totalMaxPower / effectiveCap);
        const pairsBySockets = Math.ceil((totalPSUs / 2) / totalSocketsPerPDU);
        const calculatedPairs = Math.max(1, pairsByPower, pairsBySockets);
        const numPairs = manualPduPairs !== null ? manualPduPairs : calculatedPairs;

        const pduState: Record<string, { 
            currentLoad: number, 
            usedSockets: Set<number>, 
            id: string,
            index: number,
            circuitLoads: number[]
        }> = {};
        
        for(let i=0; i < numPairs; i++) {
            pduState[`A${i+1}`] = { currentLoad: 0, usedSockets: new Set(), id: `A${i+1}`, index: i, circuitLoads: new Array(pduSpecs.circuits).fill(0) };
            pduState[`B${i+1}`] = { currentLoad: 0, usedSockets: new Set(), id: `B${i+1}`, index: i, circuitLoads: new Array(pduSpecs.circuits).fill(0) };
        }

        let currentU = rackSize;
        const positionedDevices = devices.map(d => {
             if (currentU - d.uHeight + 1 >= 1) {
                  const pos = currentU;
                  currentU -= d.uHeight;
                  return { ...d, uPosition: pos };
             }
             return { ...d, uPosition: null };
        });

        const finalDevices = runAutoConnect(
            positionedDevices, 
            pduState, 
            numPairs, 
            effectiveCap, 
            totalSocketsPerPDU,
            pduSpecs.voltage,
            pduSpecs.circuits,
            pduSpecs.amps,
            powerFactor,
            safetyMargin,
            pduCols
        );

        setActiveDevices(withMountDefaults(finalDevices));
        updateDeviceTypes(finalDevices);
        toast.success(`Loaded ${finalDevices.length} devices successfully`);
      }
    } catch (error) {
      toast.error('Failed to parse CSV file');
    }
  };
  processCSV();
}, [csvInput]); 

const updateDeviceTypes = (devices: Device[]) => {
    const types = Array.from(new Set(devices.map(d => d.name)));
    setDeviceTypes(types);
};

  // --- Handlers ---

  const handleAutoConnect = () => {
    const effectiveCap = basePduCapacity * powerFactor * (safetyMargin / 100);
    const totalSocketsPerPDU = baseSocketsPerPDU + secondarySocketsPerPDU;
    const numPairs = pdus.length / 2;

    const pduState: Record<string, { 
          currentLoad: number, 
          usedSockets: Set<number>, 
          id: string,
          index: number,
          circuitLoads: number[]
    }> = {};

    for(let i=0; i < numPairs; i++) {
        pduState[`A${i+1}`] = { currentLoad: 0, usedSockets: new Set(), id: `A${i+1}`, index: i, circuitLoads: new Array(pduSpecs.circuits).fill(0) };
        pduState[`B${i+1}`] = { currentLoad: 0, usedSockets: new Set(), id: `B${i+1}`, index: i, circuitLoads: new Array(pduSpecs.circuits).fill(0) };
    }

    const finalDevices = runAutoConnect(
        activeDevices, 
        pduState, 
        numPairs, 
        effectiveCap, 
        totalSocketsPerPDU,
        pduSpecs.voltage,
        pduSpecs.circuits,
        pduSpecs.amps,
        powerFactor,
        safetyMargin,
        pduCols
    );
    setActiveDevices(withMountDefaults(finalDevices));
  };

  const handleApplyRackSize = () => {
    const val = Number(tempRackSize);
    if (!isNaN(val) && val >= 4 && val <= 52) {
        setRackSize(Math.floor(val));
    } else {
        setTempRackSize(rackSize);
    }
  };

  // JSON schema validation for config files. PDU configuration now lives in
  // the merged PDU library inside Global Config — import/export round-trips it.
  interface ConfigSchema {
    rackSize?: number;
    pduCordLength?: number;
    rackPreset?: string;
    rackDepth?: number;
    placementStrategy?: PduPlacementStrategy;
    deviceDims?: Record<string, PhysicalDimensions>;
    safetyMargin?: number;
    powerFactor?: number;
    /** Merged PDU library — single source of truth for all PDU configuration. */
    pduLibrary?: PduType[];
    activeDevices?: Device[];
    csvInput?: string;
  }

  const validateConfigSchema = (config: any): config is ConfigSchema => {
    if (typeof config !== 'object' || config === null) return false;

    // Validate numeric fields with reasonable ranges
    if (config.rackSize !== undefined && (typeof config.rackSize !== 'number' || config.rackSize < 4 || config.rackSize > 52)) return false;
    if (config.pduCordLength !== undefined && (typeof config.pduCordLength !== 'number' || config.pduCordLength < 0 || config.pduCordLength > 100)) return false;

    // Validate rack-mount PDU placement fields
    if (config.rackPreset !== undefined && (typeof config.rackPreset !== 'string' || !(config.rackPreset in RACK_SIZES))) return false;
    if (config.rackDepth !== undefined && (typeof config.rackDepth !== 'number' || config.rackDepth < 10 || config.rackDepth > 200)) return false;
    const validStrategies = ['bottom', 'top', 'center'];
    if (config.placementStrategy !== undefined && !validStrategies.includes(config.placementStrategy)) return false;
    if (config.deviceDims !== undefined) {
      if (typeof config.deviceDims !== 'object' || config.deviceDims === null || Array.isArray(config.deviceDims)) return false;
      for (const [name, dim] of Object.entries(config.deviceDims)) {
        if (typeof name !== 'string') return false;
        if (typeof dim !== 'object' || dim === null) return false;
        for (const key of ['width', 'height', 'depth'] as const) {
          const v = (dim as any)[key];
          if (typeof v !== 'number' || v <= 0 || v > 300) return false;
        }
      }
    }
    if (config.safetyMargin !== undefined && (typeof config.safetyMargin !== 'number' || config.safetyMargin < 0 || config.safetyMargin > 100)) return false;
    if (config.powerFactor !== undefined && (typeof config.powerFactor !== 'number' || config.powerFactor < 0 || config.powerFactor > 1)) return false;

    // Validate the merged PDU library (per-type parameters + quantity)
    const validSocketTypes = ['UK', 'C13', 'C19'];
    const validInlets = ['C14', 'C20', 'IEC-309-16A', 'IEC-309-32A', 'Hardwired'];
    if (config.pduLibrary !== undefined) {
      if (!Array.isArray(config.pduLibrary)) return false;
      for (const t of config.pduLibrary) {
        if (typeof t !== 'object' || t === null) return false;
        if (typeof t.id !== 'string' || typeof t.name !== 'string') return false;
        if (t.formFactor !== 'vertical' && t.formFactor !== 'horizontal') return false;
        if (!validSocketTypes.includes(t.socketType)) return false;
        if (t.secondarySocketType !== undefined && !validSocketTypes.includes(t.secondarySocketType)) return false;
        if (!validInlets.includes(t.inletType)) return false;
        for (const key of ['socketCount', 'secondarySocketCount', 'powerCapacity', 'supplyVoltage',
                           'ratedCurrent', 'circuitCount', 'breakerRatingA', 'physicalHeightCm',
                           'uHeight', 'physicalWidthCm', 'physicalDepthCm', 'cols', 'quantity'] as const) {
          const v = (t as any)[key];
          if (v !== undefined && (typeof v !== 'number' || !isFinite(v) || v < 0)) return false;
        }
        if (typeof t.isThreePhase !== 'boolean') return false;
        if (t.mountSide !== undefined && t.mountSide !== 'front' && t.mountSide !== 'back') return false;
      }
    }

    // Validate activeDevices array structure (basic check)
    if (config.activeDevices !== undefined) {
      if (!Array.isArray(config.activeDevices)) return false;
      for (const device of config.activeDevices) {
        if (typeof device !== 'object' || device === null) return false;
        if (typeof device.id !== 'string') return false;
        if (typeof device.name !== 'string') return false;
        if (typeof device.room !== 'string') return false;
      }
    }

    return true;
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Validate file type by checking MIME type and extension
      const fileName = file.name.toLowerCase();
      const isJson = fileName.endsWith('.json');
      const isCsv = fileName.endsWith('.csv');
      
      if (!isJson && !isCsv) {
        toast.error('Invalid file type. Please upload a .csv or .json file.');
        return;
      }
      
      const reader = new FileReader();
      reader.onload = (evt) => {
        if (evt.target?.result) {
            const content = evt.target.result as string;
            if (isJson) {
                try {
                    const config = JSON.parse(content);
                    
                    // Schema validation
                    if (!validateConfigSchema(config)) {
                        toast.error('Invalid configuration file format');
                        return;
                    }
                    
                    if (config.rackSize) { setRackSize(config.rackSize); setTempRackSize(config.rackSize); }
                    if (config.pduCordLength) setPduCordLength(config.pduCordLength);
                    if (config.rackPreset) setRackPreset(config.rackPreset);
                    if (config.rackDepth) setRackDepth(config.rackDepth);
                    if (config.placementStrategy) setPlacementStrategy(config.placementStrategy);
                    if (config.deviceDims) setDeviceDims(config.deviceDims);
                    if (config.safetyMargin) setSafetyMargin(config.safetyMargin);
                    if (config.powerFactor) setPowerFactor(config.powerFactor);
                    // Merged PDU library is the single source of truth for all
                    // PDU parameters — both diagrams draw from it after load.
                    if (Array.isArray(config.pduLibrary) && config.pduLibrary.length > 0) {
                      const lib: PduType[] = config.pduLibrary.map((t: any, i: number) => ({
                        id: typeof t.id === 'string' ? t.id : `pduTypeImported${i}`,
                        name: String(t.name ?? `PDU Type ${i + 1}`),
                        formFactor: t.formFactor === 'horizontal' ? 'horizontal' : 'vertical',
                        socketType: t.socketType,
                        socketCount: Math.max(0, Math.floor(t.socketCount ?? 8)),
                        secondarySocketType: t.secondarySocketType,
                        secondarySocketCount: Math.max(0, Math.floor(t.secondarySocketCount ?? 0)),
                        powerCapacity: Math.max(0, t.powerCapacity ?? 7360),
                        inletType: t.inletType,
                        supplyVoltage: Math.max(100, t.supplyVoltage ?? 230),
                        ratedCurrent: Math.max(1, Math.floor(t.ratedCurrent ?? 32)),
                        isThreePhase: !!t.isThreePhase,
                        circuitCount: Math.max(1, Math.floor(t.circuitCount ?? 1)),
                        breakerRatingA: Math.max(6, Math.floor(t.breakerRatingA ?? 16)),
                        physicalHeightCm: Math.max(1, t.physicalHeightCm ?? (t.formFactor === 'horizontal' ? 0 : 183)),
                        uHeight: t.uHeight !== undefined
                          ? Math.max(0, Math.floor(t.uHeight))
                          : (t.formFactor === 'horizontal'
                              ? Math.max(1, Math.ceil(Math.max(0.1, (t.physicalHeightCm ?? 4.4)) * 10 / 44.45)))
                          : 0,
                        physicalWidthCm: Math.max(1, t.physicalWidthCm ?? 5.5),
                        physicalDepthCm: Math.max(1, t.physicalDepthCm ?? 7.5),
                        cols: Math.max(1, Math.min(2, Math.round(t.cols ?? 1))),
                        mountSide: t.mountSide === 'front' ? 'front' : 'back',
                        quantity: Math.max(0, Math.floor(t.quantity ?? 1)),
                      }));
                      setPduLibrary(lib);
                      // Keep the id sequence ahead of imported ids.
                      let maxSeq = 0;
                      for (const t of lib) {
                        const m = /^pduType(\d+)$/.exec(t.id);
                        if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
                      }
                      if (maxSeq >= pduSeqRef.current) pduSeqRef.current = maxSeq + 1;
                    }
                    
                    if (config.activeDevices) {
                        setActiveDevices(withMountDefaults(config.activeDevices as Device[]));
                        updateDeviceTypes(config.activeDevices);
                        toast.success(`Loaded ${config.activeDevices.length} devices from config`);
                    } else {
                        toast.success('Configuration loaded successfully');
                    }
                } catch (err) {
                    toast.error('Failed to parse configuration file');
                }
            } else {
                setCsvInput(content);
                toast.success('CSV file loaded successfully');
            }
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
        if (configInputRef.current) configInputRef.current.value = '';
      };
      reader.onerror = () => {
        toast.error('Failed to read file');
      };
      reader.readAsText(file);
    }
  };

  const handleReset = () => {
      setCsvInput(DEFAULT_CSV);
      setRackSize(48);
      setTempRackSize(48);
      setManualPduPairs(null);
      setManualPlacements({});
      setVerticalPlacements({});
  };
  
  // Helper to safely create and revoke object URLs
  const createAndRevokeObjectURL = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Revoke the object URL to prevent memory leaks
    setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  const handleDownloadTemplate = () => {
    const blob = new Blob([DEFAULT_CSV], { type: 'text/csv;charset=utf-8;' });
    createAndRevokeObjectURL(blob, 'rack_import_template.csv');
  };

  const handlePrint = () => window.print();

  const handleExportConfig = () => {
    const config = {
        activeDevices,
        rackSize,
        pduCordLength,
        rackPreset,
        rackDepth,
        placementStrategy,
        deviceDims,
        safetyMargin,
        powerFactor,
        // Single source of truth: merged PDU library (Global Config section).
        pduLibrary,
        csvInput
    };
    const jsonString = JSON.stringify(config, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    createAndRevokeObjectURL(blob, 'rack_config.json');
    setShowExportMenu(false);
  };

  const captureVisualizer = async () => {
      if (!visualizerRef.current) return null;
      try {
          const dataUrl = await toPng(visualizerRef.current, {
              backgroundColor: '#ffffff',
              pixelRatio: 2,
          });
          return dataUrl;
      } catch (err) {
          // Silently handle export errors in production
          return null;
      }
  };

  const exportImage = async () => {
      const dataUrl = await captureVisualizer();
      if (!dataUrl) return;
      const link = document.createElement('a');
      link.download = 'rack_diagram.png';
      link.href = dataUrl;
      link.click();
      setShowExportMenu(false);
  };

  const exportPDF = async () => {
      const dataUrl = await captureVisualizer();
      if (!dataUrl) return;
      
      const imgWidth = 297; 
      const pageHeight = 210; 
      
      const pdf = new jsPDF('l', 'mm', 'a4');
      const imgProps = pdf.getImageProperties(dataUrl);
      const pdfHeight = (imgProps.height * imgWidth) / imgProps.width;
      
      if (pdfHeight > pageHeight) {
          const scaledWidth = (imgProps.width * pageHeight) / imgProps.height;
          pdf.addImage(dataUrl, 'PNG', (imgWidth - scaledWidth)/2, 0, scaledWidth, pageHeight);
      } else {
          pdf.addImage(dataUrl, 'PNG', 0, (pageHeight - pdfHeight)/2, imgWidth, pdfHeight);
      }
      
      pdf.save("rack_diagram.pdf");
      setShowExportMenu(false);
  };

  const exportHTML = async () => {
      const dataUrl = await captureVisualizer();
      if (!dataUrl) return;
      
      // Sanitize device names to prevent XSS in exported HTML
      const sanitizeForHtml = (str: string): string => {
        return DOMPurify.sanitize(str, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
      };
      
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Rack Power Report</title>
            <style>
                body { font-family: system-ui, sans-serif; background: #f0f0f0; padding: 20px; text-align: center; }
                .container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); display: inline-block; }
                h1 { color: #333; }
                img { max-width: 100%; height: auto; border: 1px solid #ddd; margin-top: 20px; }
                table { margin: 20px auto; border-collapse: collapse; width: 100%; max-width: 800px; text-align: left; }
                th, td { padding: 8px; border-bottom: 1px solid #ddd; }
                th { background-color: #f8f9fa; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Rack Power Configuration Report</h1>
                <p>Generated on ${new Date().toLocaleString()}</p>
                <div>
                   <strong>Total Load:</strong> ${Math.round(maxLoad)}W (Max) / ${Math.round(totalLoad)}W (Typical)
                </div>
                <img src="${dataUrl}" alt="Rack Diagram" />
                <h2>Device Manifest</h2>
                <table>
                    <thead>
                        <tr><th>Device</th><th>U Height</th><th>PSUs</th><th>Max Power</th></tr>
                    </thead>
                    <tbody>
                        ${activeDevices.map(d => `
                            <tr>
                                <td>${sanitizeForHtml(d.name)}</td>
                                <td>${d.uHeight}U</td>
                                <td>${d.psuCount}</td>
                                <td>${d.powerRatingPerDevice}W</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </body>
        </html>
      `;
      const blob = new Blob([htmlContent], { type: 'text/html' });
      createAndRevokeObjectURL(blob, 'rack_report.html');
      setShowExportMenu(false);
  };

  // Move Device Logic
  const handleMoveDevice = (id: string, targetU: number) => {
    setActiveDevices(prev => {
        const sourceDevice = prev.find(d => d.id === id);
        if (!sourceDevice) return prev;

        const targetDevice = prev.find(d => 
            d.id !== id && 
            d.uPosition !== null && 
            targetU <= d.uPosition && 
            targetU >= d.uPosition - d.uHeight + 1
        );

        let newDevices = [...prev];

        if (targetDevice) {
            const sourcePos = targetDevice.uPosition;
            const targetPos = sourceDevice.uPosition;

            newDevices = newDevices.map(d => {
                if (d.id === sourceDevice.id) return { ...d, uPosition: sourcePos };
                if (d.id === targetDevice.id) return { ...d, uPosition: targetPos };
                return d;
            });
        } else {
            newDevices = newDevices.map(d => {
                if (d.id === sourceDevice.id) return { ...d, uPosition: targetU };
                return d;
            });
        }

        const hasConflict = newDevices.some((d1, i) => {
            if (d1.uPosition === null) return false;
            
            if (d1.uPosition > rackSize) return true;
            if (d1.uPosition - d1.uHeight + 1 < 1) return true;

            return newDevices.some((d2, j) => {
                if (i === j) return false;
                if (d2.uPosition === null) return false;

                const d1Top = d1.uPosition!;
                const d1Bot = d1.uPosition! - d1.uHeight + 1;
                const d2Top = d2.uPosition!;
                const d2Bot = d2.uPosition! - d2.uHeight + 1;

                return Math.max(d1Bot, d2Bot) <= Math.min(d1Top, d2Top);
            });
        });

        return hasConflict ? prev : newDevices;
    });
  };

  const handleConnectionUpdate = (
      deviceId: string, 
      psuIndex: number, 
      pduId: string | null, 
      socketIndex: number|null
  ) => {
      setActiveDevices(prev => {
          const sourceDevice = prev.find(d => d.id === deviceId);
          if (!sourceDevice) return prev;
          const sourcePrevConn = sourceDevice.psuConnections[psuIndex];

          let occupant: { deviceId: string, psuIdx: number } | null = null;
          
          if (pduId && socketIndex !== null) {
              for (const d of prev) {
                  for(const [idxStr, c] of Object.entries(d.psuConnections)) {
                      const conn = c as PSUConnection | null;
                      if (conn && conn.pduId === pduId && conn.socketIndex === socketIndex) {
                          if (d.id === deviceId && parseInt(idxStr) === psuIndex) return prev;
                          occupant = { deviceId: d.id, psuIdx: parseInt(idxStr) };
                          break;
                      }
                  }
                  if (occupant) break;
              }
          }

          return prev.map(d => {
              const newConns = { ...d.psuConnections };
              let modified = false;

              if (d.id === deviceId) {
                  if (pduId === null) {
                      newConns[psuIndex] = null;
                  } else {
                      newConns[psuIndex] = { pduId, socketIndex: socketIndex! };
                  }
                  modified = true;
              }

              if (occupant && d.id === occupant.deviceId) {
                  newConns[occupant.psuIdx] = sourcePrevConn || null;
                  modified = true;
              }

              return modified ? { ...d, psuConnections: newConns } : d;
          });
      });
  };

  const openGroupEditor = (type: string) => {
      const sample = activeDevices.find(d => d.name === type);
      if (sample) {
          setEditingType(type);
          setEditValues({
              uHeight: sample.uHeight,
              typical: sample.typicalPower,
              max: sample.powerRatingPerDevice
          });
          setEditDims(deviceDims[type] || { ...DEFAULT_DEVICE_DIM, height: sample.uHeight * 4.45 });
          setEditGroupModalOpen(true);
      }
  };

  const saveGroupEdit = () => {
      setActiveDevices(prev => {
          return prev.map(d => {
              if (d.name === editingType) {
                  return {
                      ...d,
                      uHeight: editValues.uHeight,
                      typicalPower: editValues.typical,
                      powerRatingPerDevice: editValues.max
                  };
              }
              return d;
          });
      });
      setDeviceDims(prev => ({ ...prev, [editingType]: { ...editDims } }));
      setEditGroupModalOpen(false);
  };

  const totalLoad = activeDevices.reduce((sum, d) => sum + d.typicalPower, 0); 
  const maxLoad = activeDevices.reduce((sum, d) => sum + d.powerRatingPerDevice, 0);

  const pduLoads = useMemo(() => {
    const loads: Record<string, { typical: number, max: number }> = {};
    pdus.forEach(p => loads[p.id] = { typical: 0, max: 0 });

    activeDevices.forEach(d => {
        const connectedPSUs = Object.values(d.psuConnections).filter(c => c !== null).length;
        if (connectedPSUs === 0) return;

        const deviceMax = d.powerRatingPerDevice;
        const deviceTyp = d.typicalPower;
        
        const pduIds = new Set<string>();
        Object.values(d.psuConnections).forEach((c) => {
            const conn = c as PSUConnection | null;
            if(conn) pduIds.add(conn.pduId);
        });
        
        pduIds.forEach(pid => {
            if (loads[pid]) {
                loads[pid].max += deviceMax;
                loads[pid].typical += (deviceTyp / pduIds.size);
            }
        });
    });
    return loads;
  }, [activeDevices, pdus]);

  // --- Automatic rack-mount PDU placement -----------------------------------
  const placement = useMemo(() => calculatePduPlacement({
    rackSizeU: rackSize,
    devices: activeDevices,
    pdus,
    deviceDims,
    defaultDeviceDim: DEFAULT_DEVICE_DIM,
    pduVertSpaceU,
    pduInletType,
    strategy: placementStrategy,
    pduPhysicalHeightCm: pduPhysicalHeight, // state is in cm
    pduCordLengthM: pduCordLength,
    manualPlacements,
    verticalPlacements,
  }), [rackSize, activeDevices, pdus, deviceDims, pduVertSpaceU, pduInletType, placementStrategy, pduPhysicalHeight, pduCordLength, manualPlacements, verticalPlacements]);

  // --- Side-view placement handlers ------------------------------------------
  const handlePlacePdu = useCallback((pduId: string, uPosition: number, mountSide: MountSide) => {
    setManualPlacements(prev => {
      const cur = prev[pduId];
      if (cur && cur.uPosition === uPosition && cur.mountSide === mountSide) return prev;
      return { ...prev, [pduId]: { uPosition, mountSide } };
    });
  }, []);

  const handleResetPduPlacement = useCallback((pduId: string) => {
    setManualPlacements(prev => {
      if (!prev[pduId]) return prev;
      const next = { ...prev };
      delete next[pduId];
      return next;
    });
  }, []);

  const handleSetDeviceSide = useCallback((deviceId: string, side: MountSide) => {
    setActiveDevices(prev => {
      const d = prev.find(x => x.id === deviceId);
      if (!d || d.mountSide === side) return prev;
      return prev.map(x => x.id === deviceId ? { ...x, mountSide: side } : x);
    });
  }, []);

  /** Assign a vertical (zero-U) PDU to a rear channel (left/right), optionally
   *  with a manual start height from the rack floor in cm. */
  const handleSetVerticalChannel = useCallback((pduId: string, channel: VerticalChannel, startCmFromFloor?: number) => {
    setVerticalPlacements(prev => {
      const cur = prev[pduId];
      if (cur && cur.channel === channel && cur.startCmFromFloor === startCmFromFloor) return prev;
      return { ...prev, [pduId]: { channel, startCmFromFloor } };
    });
  }, []);

  const autoRequiredU = pduRequiredU(pduPhysicalHeight, pduInletType);

  const handleApplyRackPreset = (preset: string) => {
    setRackPreset(preset);
    const spec = RACK_SIZES[preset];
    if (spec) {
      setRackSize(spec.internalU);
      setTempRackSize(spec.internalU);
      setRackDepth(spec.external.depth);
    }
  };

  return (
    <div className="min-h-screen themed-app p-4 md:p-8">
      {/* Header */}
      <header className="max-w-[1920px] mx-auto mb-6 flex flex-col lg:flex-row justify-between items-center gap-4 no-print">
        <div>
           <h1 className="text-3xl font-bold themed-heading tracking-tight">Rack Power Architect</h1>
           <p className="themed-muted mt-1">Interactive Layout & Power Planning</p>
        </div>

        {/* Tab Navigation */}
        <nav
          role="tablist"
          aria-label="Main sections"
          className="flex items-center gap-1 themed-card border rounded-lg p-1 shadow-lg"
        >
          {([
            { id: 'config', label: 'Config', Icon: Settings },
            { id: 'wiring', label: 'Wiring View', Icon: Boxes },
            { id: 'reports', label: 'Reports', Icon: ClipboardList },
          ] as { id: TabId; label: string; Icon: typeof Settings }[]).map(({ id, label, Icon }) => (
            <button
              key={id}
              role="tab"
              id={`tab-${id}`}
              aria-selected={activeTab === id}
              aria-controls={`tabpanel-${id}`}
              tabIndex={activeTab === id ? 0 : -1}
              onClick={() => setActiveTab(id)}
              onKeyDown={(e) => {
                const order: TabId[] = ['config', 'wiring', 'reports'];
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const cur = order.indexOf(activeTab);
                  const next = e.key === 'ArrowRight'
                    ? order[(cur + 1) % order.length]
                    : order[(cur + order.length - 1) % order.length];
                  setActiveTab(next);
                }
              }}
              className={`px-4 py-2 rounded-md text-sm font-semibold flex items-center gap-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${activeTab === id ? 'themed-tab-active border themed-divider' : 'themed-tab-inactive hover:opacity-80 bg-transparent border border-transparent'}`}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
        </nav>

        <div className="flex gap-2 relative flex-wrap justify-center">
             <button
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                className="px-3 py-2 themed-card border rounded hover:opacity-80 themed-muted flex items-center gap-2"
             >
                 {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
             </button>

             <button onClick={handleAutoConnect} className="px-3 py-2 bg-orange-700 rounded border border-orange-600 hover:bg-orange-600 text-white flex items-center gap-2" title="Recalculate wiring based on current positions">
                 <RefreshCw size={16} /> Recalculate Wiring
             </button>

             <button onClick={handleReset} className="px-3 py-2 themed-card border rounded hover:opacity-80 flex items-center gap-2 themed-muted">
                 <RotateCcw size={16} /> Reset
             </button>

             <button onClick={handleDownloadTemplate} className="px-3 py-2 themed-card border rounded hover:opacity-80 flex items-center gap-2 themed-muted" title="Download CSV Template">
                 <FileText size={16} /> Template
             </button>

             <label className="px-3 py-2 bg-blue-600 rounded cursor-pointer hover:bg-blue-500 text-white flex items-center gap-2" title="Import Rack Data from CSV">
                 <Upload size={16} /> Import CSV
                 <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
             </label>

             <label className="px-3 py-2 bg-indigo-600 rounded cursor-pointer hover:bg-indigo-500 text-white flex items-center gap-2" title="Load Configuration from JSON">
                 <FileJson size={16} /> Load Config
                 <input ref={configInputRef} type="file" accept=".json" onChange={handleFileUpload} className="hidden" />
             </label>

             <div className="relative">
                 <button
                    onClick={() => setShowExportMenu(!showExportMenu)}
                    aria-haspopup="menu"
                    aria-expanded={showExportMenu}
                    className="px-3 py-2 bg-emerald-600 rounded hover:bg-emerald-500 text-white flex items-center gap-2"
                 >
                     <Download size={16} /> Export
                 </button>
                 {showExportMenu && (
                     <div role="menu" className="absolute right-0 mt-2 w-48 bg-white text-slate-900 rounded-lg shadow-xl z-50 overflow-hidden border border-slate-200">
                         <button role="menuitem" onClick={handleExportConfig} className="w-full text-left px-4 py-3 hover:bg-slate-100 flex items-center gap-2 border-b border-slate-100">
                             <FileJson size={16} className="text-orange-500" /> Save Config (JSON)
                         </button>
                         <button role="menuitem" onClick={exportImage} className="w-full text-left px-4 py-3 hover:bg-slate-100 flex items-center gap-2 border-b border-slate-100">
                             <FileImage size={16} className="text-emerald-600" /> Save as Image (PNG)
                         </button>
                         <button role="menuitem" onClick={exportPDF} className="w-full text-left px-4 py-3 hover:bg-slate-100 flex items-center gap-2 border-b border-slate-100">
                             <FileText size={16} className="text-red-600" /> Save as PDF
                         </button>
                         <button role="menuitem" onClick={exportHTML} className="w-full text-left px-4 py-3 hover:bg-slate-100 flex items-center gap-2">
                             <FileCode size={16} className="text-blue-600" /> Save as Report (HTML)
                         </button>
                         <button role="menuitem" onClick={handlePrint} className="w-full text-left px-4 py-3 hover:bg-slate-100 flex items-center gap-2 border-t border-slate-100 bg-slate-50 text-slate-500">
                             <Printer size={16} /> Print View
                         </button>
                     </div>
                 )}
                 {showExportMenu && (
                     <div className="fixed inset-0 z-40 bg-transparent" onClick={() => setShowExportMenu(false)}></div>
                 )}
             </div>
        </div>
      </header>

      {/* Main Layout */}
      <main className="max-w-[1920px] mx-auto grid grid-cols-1 xl:grid-cols-5 gap-8">

        {/* ============ CONFIG TAB ============ */}
        <aside
          role="tabpanel"
          id="tabpanel-config"
          aria-labelledby="tab-config"
          className={`${activeTab === 'config' ? 'block' : 'hidden'} xl:block xl:col-span-1 space-y-6 h-fit xl:sticky xl:top-4 no-print`}
        >
            {/* Global Config */}
            <div className="themed-card border p-5 rounded-xl shadow-lg">
                <h3 className="font-bold themed-heading mb-4 flex items-center gap-2"><Settings size={18} /> Global Config</h3>
                <div className="space-y-4">

                    {/* Rack Size */}
                    <div className="border-b themed-divider pb-3">
                        <label className="text-xs themed-muted uppercase font-bold">Rack Preset</label>
                        <select
                            aria-label="Rack size preset"
                            value={rackPreset}
                            onChange={e => handleApplyRackPreset(e.target.value)}
                            className="w-full themed-input border rounded p-2 mt-1 text-sm"
                        >
                            {Object.entries(RACK_SIZES).map(([k, v]) => (
                                <option key={k} value={k}>{v.label} · {v.external.width}×{v.external.height}×{v.external.depth} cm</option>
                            ))}
                        </select>
                        <label className="text-xs themed-muted uppercase font-bold block mt-2">Rack Size (U)</label>
                        <div className="flex gap-2 mt-1 mb-2">
                            <input
                                type="number" min="4" max="52" aria-label="Rack size in U"
                                value={tempRackSize} onChange={e => setTempRackSize(e.target.value)}
                                className="w-full themed-input border rounded p-2"
                            />
                            <button onClick={handleApplyRackSize} className="bg-blue-600 hover:bg-blue-500 text-white px-2 rounded text-xs font-bold">SET</button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <span className="text-[10px] themed-dim block">External Depth (cm)</span>
                                <input
                                    type="number" min="10" max="200" aria-label="Rack external depth in cm"
                                    value={rackDepth} onChange={e => setRackDepth(Math.max(10, Math.min(200, Number(e.target.value) || 10)))}
                                    className="w-full themed-input border rounded p-2"
                                />
                            </div>
                            <div className="themed-input border rounded p-2 text-[10px] themed-dim flex flex-col justify-center">
                                <span>Usable height: <b className="themed-muted">{(rackSize * 4.45).toFixed(1)} cm</b></span>
                                <span>Free after PDUs: <b className="themed-muted">{placement.freeU}U</b></span>
                            </div>
                        </div>
                    </div>

                    {/* Inferred Specs Display */}
                    <div className="border-b themed-divider pb-3 pt-2">
                        <div className="text-[10px] uppercase font-bold themed-dim mb-1 flex items-center gap-1">
                            <Zap size={10} className="text-yellow-500" />
                            PDU Electrical Specs
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs themed-muted">
                             <div className="themed-input p-1.5 rounded border themed-divider">
                                 <div className="text-[9px] themed-dim">Output Phase</div>
                                 <div className="font-mono">{pduSpecs.voltage}V</div>
                             </div>
                             <div className="themed-input p-1.5 rounded border themed-divider">
                                 <div className="text-[9px] themed-dim">Breakers</div>
                                 <div className="font-mono">{pduSpecs.circuits}x {pduSpecs.amps}A</div>
                             </div>
                        </div>
                    </div>

                    {/* PDU Count Control */}
                    <div className="border-b themed-divider pb-3">
                        <label className="text-xs themed-muted uppercase font-bold flex justify-between items-center">
                            <span>PDU Pairs (A+B)</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${manualPduPairs !== null ? 'bg-orange-900/50 text-orange-400 border border-orange-800' : 'themed-input themed-dim border themed-divider'}`}>
                                {manualPduPairs !== null ? 'MANUAL' : 'AUTO'}
                            </span>
                        </label>
                        <div className="flex items-center gap-2 mt-2">
                             <button
                                aria-label="Decrease PDU pairs"
                                onClick={() => {
                                    if (activePduPairs > calculatedPduPairs) {
                                        const newValue = activePduPairs - 1;
                                        setManualPduPairs(newValue === calculatedPduPairs ? null : newValue);
                                    }
                                }}
                                disabled={activePduPairs <= calculatedPduPairs}
                                className={`p-2 rounded border flex-1 flex justify-center ${activePduPairs <= calculatedPduPairs ? 'themed-input themed-dim border themed-divider cursor-not-allowed' : 'bg-slate-700 hover:bg-slate-600 text-white border-slate-600'}`}
                             >
                                <Minus size={16} />
                             </button>

                             <div className="flex-1 text-center font-mono font-bold text-xl themed-input border themed-divider rounded py-1.5" aria-live="polite">
                                {activePduPairs}
                             </div>

                             <button
                                aria-label="Increase PDU pairs"
                                onClick={() => setManualPduPairs(activePduPairs + 1)}
                                className="p-2 rounded border bg-slate-700 hover:bg-slate-600 text-white border-slate-600 flex-1 flex justify-center"
                             >
                                <Plus size={16} />
                             </button>
                        </div>
                        <div className="text-[10px] themed-dim mt-1 text-center">
                            Min Required: {calculatedPduPairs} pair(s) based on capacity & sockets.
                        </div>
                    </div>

                    {/* Rack-Mount PDU Placement — reads from the merged PDU Library */}
                    <div className="border-b themed-divider pb-3">
                        <label className="text-xs themed-muted uppercase font-bold flex items-center justify-between">
                            <span>Rack-Mount PDU Placement</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded themed-input themed-dim border themed-divider">
                                {(() => {
                                  const anyVert = pduInstances.some(p => p.formFactor === 'vertical');
                                  const anyHoriz = pduInstances.some(p => p.formFactor === 'horizontal');
                                  if (anyVert && anyHoriz) return 'VERT 0U + HORIZ';
                                  if (anyVert) return 'VERTICAL 0U';
                                  if (anyHoriz) return `${placementStrategy.toUpperCase()} BAND`;
                                  return 'NO PDUs DEFINED';
                                })()}
                            </span>
                        </label>
                        <div className="mt-2 themed-input border rounded p-2 text-[10px] themed-dim flex flex-wrap gap-x-4 justify-center">
                            <span>H-PDU total U: <b className="themed-muted">{placement.placements.filter(p => p.formFactor === 'horizontal').reduce((s, p) => s + p.uSpan, 0)}U</b></span>
                            <span>Inlet bend: <b className="themed-muted">{CORD_BEND_CM[pduInletType]} cm</b></span>
                            <span>Free after PDUs: <b className="themed-muted">{placement.freeU}U</b></span>
                        </div>
                        <div className="mt-2">
                            <span className="text-[10px] themed-dim block">Placement Strategy (horizontal PDUs; vertical strips use rear L/R channels)</span>
                            <select
                                aria-label="PDU placement strategy"
                                value={placementStrategy}
                                onChange={e => setPlacementStrategy(e.target.value as PduPlacementStrategy)}
                                className="w-full themed-input border rounded p-2 text-sm"
                            >
                                <option value="bottom">Bottom band (recommended)</option>
                                <option value="center">Center of rack</option>
                                <option value="top">Top of rack</option>
                            </select>
                        </div>
                        {Object.keys(manualPlacements).length > 0 && (
                            <button
                                type="button"
                                onClick={() => setManualPlacements({})}
                                className="mt-2 w-full text-[11px] themed-input border themed-divider rounded p-1.5 hover:opacity-80"
                                aria-label="Clear all manual PDU placements"
                            >
                                Clear manual placements ({Object.keys(manualPlacements).length}) → re-auto-place all
                            </button>
                        )}
                        <div className="mt-2 text-[10px] themed-dim space-y-1" aria-live="polite">
                            {placement.warnings.length === 0 && <div>No placement issues detected.</div>}
                            {placement.warnings.map((w, i) => (
                                <div key={i} className={`flex gap-1 items-start ${w.level === 'error' ? 'text-red-400' : w.level === 'warning' ? 'text-amber-400' : 'themed-muted'}`}>
                                    <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                                    <span>{w.message}</span>
                                </div>
                            ))}
                        </div>
                        {placement.placements.filter(p => p.formFactor === 'horizontal').length > 0 && (
                            <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] font-mono themed-muted">
                                {placement.placements.filter(p => p.formFactor === 'horizontal').map(p => (
                                    <div key={p.pduId} className="themed-input border themed-divider rounded px-1.5 py-1 flex justify-between">
                                        <span>{p.pduId} · {p.mountSide}{manualPlacements[p.pduId] ? '*' : ''}</span>
                                        <span title={`${(p.startMm/10).toFixed(1)}–${(p.endMm/10).toFixed(1)} cm from floor`}>U{p.uPosition - p.uSpan + 1}–{p.uPosition}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    <div>
                        <label className="text-xs themed-muted uppercase font-bold">Cord Length (m)</label>
                        <input
                            type="number" min="0.5" step="0.5" aria-label="PDU cord length in meters"
                            value={pduCordLength} onChange={e => setPduCordLength(Number(e.target.value))}
                            className="w-full themed-input border rounded p-2 mt-1"
                        />
                    </div>


                    <div>
                         <label className="text-xs themed-muted uppercase font-bold flex justify-between">
                            <span>Power Factor</span> <span>{powerFactor}</span>
                         </label>
                         <input type="range" aria-label="Power factor" min="0.5" max="1" step="0.01" value={powerFactor} onChange={e => setPowerFactor(Number(e.target.value))} className="w-full accent-emerald-500"/>
                    </div>

                    {/* ============ PDU CONFIGURATION (merged from former PDU Library section) ============
                        Defines BOTH vertical (zero-U rear-channel) and rack-based horizontal PDUs.
                        Single source of truth — front elevation, side view, wiring & reports all draw from it. */}
                    <div className="border-t themed-divider pt-3">
                        <h4 className="font-bold themed-heading mb-1 flex items-center gap-2 text-sm"><Zap size={16} /> PDU Configuration</h4>
                        <p className="text-[10px] themed-dim mb-3">
                            Define PDU types with parameters &amp; quantity — both vertical (zero-U) and rack-based PDUs live here.
                            Vertical PDUs mount on the rear left/right channels; they cannot overlap and total strip length must fit within rack height ({rackSize}U).
                            Rack-based PDU height is configured in U; only mounting depth is set in centimetres. All rack-based PDUs share the same power rating configuration.
                        </p>
            {/* ============ PDU LIBRARY (PDUs treated like devices) ============ */}
            <div>

                <div className="flex flex-col gap-3 max-h-[420px] overflow-y-auto pr-2" aria-label="PDU types">
                    {pduLibrary.map(t => {
                        const isVert = t.formFactor === 'vertical';
                        return (
                            <div key={t.id} className="themed-input border themed-divider rounded-lg p-3 space-y-2">
                                <div className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        aria-label={`PDU type name`}
                                        value={t.name}
                                        onChange={e => updatePduType(t.id, { name: e.target.value })}
                                        className="flex-1 min-w-0 bg-transparent border-b themed-divider text-sm font-semibold themed-heading focus:outline-none"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => removePduType(t.id)}
                                        aria-label={`Delete PDU type ${t.name}`}
                                        title="Delete PDU type"
                                        className="p-1.5 rounded hover:bg-red-500/20 text-red-400 shrink-0"
                                    >
                                        <Minus size={14} />
                                    </button>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <span className="text-[10px] themed-dim block">Form Factor</span>
                                        <select
                                            aria-label={`${t.name} form factor`}
                                            value={t.formFactor}
                                            onChange={e => updatePduType(t.id, {
                                                formFactor: e.target.value as PduFormFactor,
                                                // Vertical strips are measured in cm length; rack-based PDUs in U + depth only.
                                                ...(e.target.value === 'vertical'
                                                  ? { physicalHeightCm: t.physicalHeightCm > 0 ? t.physicalHeightCm : 183, uHeight: 0, physicalDepthCm: t.physicalDepthCm || 5.6 }
                                                  : { uHeight: Math.max(1, Math.round(t.uHeight || 1)), physicalHeightCm: 0, physicalDepthCm: t.physicalDepthCm || 7.5 }),
                                            })}
                                            className="w-full themed-input border themed-divider rounded p-1.5 text-xs"
                                        >
                                            <option value="vertical">Vertical (zero-U, rear)</option>
                                            <option value="horizontal">Horizontal (rack-mount)</option>
                                        </select>
                                    </div>
                                    <div>
                                        <span className="text-[10px] themed-dim block">Quantity</span>
                                        <div className="flex items-center gap-1">
                                            <button
                                                type="button"
                                                onClick={() => updatePduType(t.id, { quantity: Math.max(0, Math.floor(t.quantity) - 1) })}
                                                aria-label={`Decrease quantity of ${t.name}`}
                                                className="p-1.5 rounded border themed-divider themed-input hover:opacity-80 shrink-0"
                                            >
                                                <Minus size={12} />
                                            </button>
                                            <input
                                                type="number" min="0" step="1"
                                                aria-label={`Quantity of ${t.name}`}
                                                value={t.quantity}
                                                onChange={e => updatePduType(t.id, { quantity: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                                                className="w-full themed-input border themed-divider rounded p-1.5 text-xs text-center"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => updatePduType(t.id, { quantity: Math.floor(t.quantity) + 1 })}
                                                aria-label={`Increase quantity of ${t.name}`}
                                                className="p-1.5 rounded border themed-divider themed-input hover:opacity-80 shrink-0"
                                            >
                                                <Plus size={12} />
                                            </button>
                                        </div>
                                    </div>
                                    <div>
                                        <span className="text-[10px] themed-dim block">Primary Outlets</span>
                                        <div className="flex gap-1">
                                            <select
                                                aria-label={`${t.name} primary socket type`}
                                                value={t.socketType}
                                                onChange={e => updatePduType(t.id, { socketType: e.target.value as SocketType })}
                                                className="w-1/2 themed-input border themed-divider rounded p-1.5 text-xs"
                                            >
                                                <option value="C13">C13</option>
                                                <option value="C19">C19</option>
                                                <option value="UK">UK</option>
                                            </select>
                                            <input
                                                type="number" min="0"
                                                aria-label={`${t.name} primary socket count`}
                                                value={t.socketCount}
                                                onChange={e => updatePduType(t.id, { socketCount: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                                                className="w-1/2 themed-input border themed-divider rounded p-1.5 text-xs"
                                            />
                                        </div>
                                    </div>
                                    <div>
                                        <span className="text-[10px] themed-dim block">Secondary Outlets</span>
                                        <div className="flex gap-1">
                                            <select
                                                aria-label={`${t.name} secondary socket type`}
                                                value={t.secondarySocketType ?? ''}
                                                onChange={e => updatePduType(t.id, {
                                                    secondarySocketType: (e.target.value || undefined) as SocketType | undefined,
                                                    secondarySocketCount: e.target.value ? (t.secondarySocketCount ?? 4) : 0,
                                                })}
                                                className="w-1/2 themed-input border themed-divider rounded p-1.5 text-xs"
                                            >
                                                <option value="">None</option>
                                                <option value="C13">C13</option>
                                                <option value="C19">C19</option>
                                                <option value="UK">UK</option>
                                            </select>
                                            <input
                                                type="number" min="0"
                                                aria-label={`${t.name} secondary socket count`}
                                                value={t.secondarySocketCount ?? 0}
                                                onChange={e => updatePduType(t.id, { secondarySocketCount: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                                                className="w-1/2 themed-input border themed-divider rounded p-1.5 text-xs"
                                            />
                                        </div>
                                    </div>
                                    <div>
                                        <span className="text-[10px] themed-dim block">{isVert ? 'Strip Length (cm)' : 'Height (U)'}</span>
                                        {isVert ? (
                                            <input
                                                type="number" min="1" step="0.1"
                                                aria-label={`${t.name} strip length in cm`}
                                                value={t.physicalHeightCm}
                                                onChange={e => updatePduType(t.id, { physicalHeightCm: Math.max(1, Number(e.target.value) || 1) })}
                                                className="w-full themed-input border themed-divider rounded p-1.5 text-xs"
                                            />
                                        ) : (
                                            <select
                                                aria-label={`${t.name} rack unit height`}
                                                value={Math.max(1, Math.round(t.uHeight || 1))}
                                                onChange={e => updatePduType(t.id, { uHeight: Math.max(1, Math.min(rackSize, Math.floor(Number(e.target.value) || 1))) })}
                                                className="w-full themed-input border themed-divider rounded p-1.5 text-xs"
                                            >
                                                <option value="1">1U</option>
                                                <option value="2">2U</option>
                                                <option value="3">3U</option>
                                                <option value="4">4U</option>
                                            </select>
                                        )}
                                    </div>
                                    <div>
                                        <span className="text-[10px] themed-dim block">{isVert ? 'Body Depth (cm)' : 'Mounting Depth (cm)'}</span>
                                        <input
                                            type="number" min="1" step="0.1"
                                            aria-label={`${t.name} physical depth in cm`}
                                            value={t.physicalDepthCm}
                                            onChange={e => updatePduType(t.id, { physicalDepthCm: Math.max(1, Number(e.target.value) || 1) })}
                                            className="w-full themed-input border themed-divider rounded p-1.5 text-xs"
                                        />
                                    </div>
                                </div>
                                {/* ---- Power input configuration (inlet + supply) ---- */}
                                <div className="pt-2 mt-1 border-t themed-divider grid grid-cols-2 gap-2">
                                    <div className="col-span-2 text-[10px] themed-dim font-semibold uppercase tracking-wide">Power Input</div>
                                    <div>
                                        <span className="text-[10px] themed-dim block">Inlet / Plug</span>
                                        <select
                                            aria-label={`${t.name} inlet type`}
                                            value={t.inletType}
                                            onChange={e => {
                                                const inlet = e.target.value as PduInletType;
                                                const maxA = INLET_MAX_AMPS[inlet];
                                                updatePduType(t.id, {
                                                    inletType: inlet,
                                                    ratedCurrent: Math.min(t.ratedCurrent, maxA),
                                                    breakerRatingA: Math.min(t.breakerRatingA, maxA),
                                                });
                                            }}
                                            className="w-full themed-input border themed-divider rounded p-1.5 text-xs"
                                        >
                                            <option value="C14">IEC C14 (16 A)</option>
                                            <option value="C20">IEC C20 (20 A)</option>
                                            <option value="IEC-309-16A">IEC 60309 16 A</option>
                                            <option value="IEC-309-32A">IEC 60309 32 A</option>
                                            <option value="Hardwired">Hardwired (≤63 A)</option>
                                        </select>
                                    </div>
                                    <div>
                                        <span className="text-[10px] themed-dim block">Supply</span>
                                        <select
                                            aria-label={`${t.name} supply phase`}
                                            value={t.isThreePhase ? '3' : '1'}
                                            onChange={e => updatePduType(t.id, { isThreePhase: e.target.value === '3' })}
                                            className="w-full themed-input border themed-divider rounded p-1.5 text-xs"
                                        >
                                            <option value="1">1-Phase</option>
                                            <option value="3">3-Phase</option>
                                        </select>
                                    </div>
                                    <div>
                                        <span className="text-[10px] themed-dim block">Voltage (V)</span>
                                        <input
                                            type="number" min="100" max="690" step="1"
                                            aria-label={`${t.name} supply voltage`}
                                            value={t.supplyVoltage}
                                            onChange={e => updatePduType(t.id, { supplyVoltage: Math.max(100, Math.min(690, Number(e.target.value) || 230)) })}
                                            className="w-full themed-input border themed-divider rounded p-1.5 text-xs"
                                        />
                                    </div>
                                    <div>
                                        <span className="text-[10px] themed-dim block">Rated Current (A/φ)</span>
                                        <input
                                            type="number" min="1" max={INLET_MAX_AMPS[t.inletType]} step="1"
                                            aria-label={`${t.name} rated current per phase`}
                                            value={t.ratedCurrent}
                                            onChange={e => updatePduType(t.id, { ratedCurrent: Math.max(1, Math.min(INLET_MAX_AMPS[t.inletType], Math.floor(Number(e.target.value) || 1))) })}
                                            className="w-full themed-input border themed-divider rounded p-1.5 text-xs"
                                        />
                                    </div>
                                    <div>
                                        <span className="text-[10px] themed-dim block">Line Inputs / Circuits</span>
                                        <input
                                            type="number" min="1" max="6" step="1"
                                            aria-label={`${t.name} number of circuits`}
                                            value={t.circuitCount}
                                            onChange={e => updatePduType(t.id, { circuitCount: Math.max(1, Math.min(6, Math.floor(Number(e.target.value) || 1))) })}
                                            className="w-full themed-input border themed-divider rounded p-1.5 text-xs"
                                        />
                                    </div>
                                    <div>
                                        <span className="text-[10px] themed-dim block">Breaker (A/circuit)</span>
                                        <input
                                            type="number" min="6" max="63" step="1"
                                            aria-label={`${t.name} breaker rating per circuit`}
                                            value={t.breakerRatingA}
                                            onChange={e => updatePduType(t.id, { breakerRatingA: Math.max(6, Math.min(INLET_MAX_AMPS[t.inletType], Math.floor(Number(e.target.value) || 6))) })}
                                            className="w-full themed-input border themed-divider rounded p-1.5 text-xs"
                                        />
                                    </div>
                                </div>
                                <div className="text-[10px] themed-dim flex justify-between gap-2 flex-wrap">
                                    <span>Power rating: <b>{basePduCapacity.toLocaleString()}W</b> (shared config)</span>
                                    <span>Inlet limit {INLET_MAX_AMPS[t.inletType]} A · feed wire {INLET_WIRE_MM2[t.inletType]}</span>
                                    <span>{isVert ? `${Math.ceil((t.physicalHeightCm * 10) / 44.45)}U of ${rackSize}U per strip` : `${Math.max(1, Math.round(t.uHeight || 1))}U × ${t.physicalDepthCm.toFixed(1)} cm deep each`}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
                <button
                    type="button"
                    onClick={addPduType}
                    className="mt-3 w-full py-2 px-4 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded transition-colors flex items-center justify-center gap-2"
                    aria-label="Add new PDU type"
                >
                    <Plus size={16} /> Add PDU Type
                </button>
                <div className="mt-2 text-[10px] themed-dim">
                    Active instances: {pduInstances.length} ({pduInstances.filter(p => p.formFactor === 'vertical').length} vertical / {pduInstances.filter(p => p.formFactor === 'horizontal').length} horizontal) · Available pairs: {pduAvailablePairs}
                </div>
            </div>
                    </div>
                </div>
            </div>

            {/* Device Group Editor */}
            <div className="themed-card border p-5 rounded-xl shadow-lg">
                <h3 className="font-bold themed-heading mb-4 flex items-center gap-2"><Edit3 size={18} /> Device Library</h3>
                <div className="flex flex-col gap-2 max-h-60 overflow-y-auto pr-2">
                    {deviceTypes.map(type => (
                        <button
                            key={type}
                            onClick={() => openGroupEditor(type)}
                            className="text-left text-sm p-2 themed-input hover:opacity-80 rounded border themed-divider truncate"
                        >
                            {type}
                        </button>
                    ))}
                </div>
            </div>

            {/* Stats Summary */}
             <div className="themed-card border p-5 rounded-xl shadow-lg">
                 <h3 className="font-bold themed-heading mb-4 flex items-center gap-2"><BatteryCharging size={18} /> Summary</h3>
                 <div className="flex justify-between items-center">
                    <span className="text-sm themed-muted">Total Max Load</span>
                    <span className="text-xl font-mono font-bold themed-heading">{Math.round(maxLoad)}W</span>
                 </div>
                 <div className="flex justify-between items-center mt-1">
                    <span className="text-sm themed-muted">Total Typical</span>
                    <span className="text-md font-mono text-emerald-400">{Math.round(totalLoad)}W</span>
                 </div>
                 <div className="mt-4 pt-4 border-t themed-divider text-xs themed-dim">
                    Required PDUs: {calculatedPduPairs} pair(s) based on capacity & sockets.
                    {manualPduPairs !== null && <div className="text-orange-400 mt-1">Overridden to {manualPduPairs} pairs.</div>}
                 </div>
             </div>
        </aside>

        {/* ============ WIRING TAB ============ */}
        <section
          role="tabpanel"
          id="tabpanel-wiring"
          aria-labelledby="tab-wiring"
          className={`${activeTab === 'wiring' ? 'block' : 'hidden'} xl:col-span-4 xl:!flex justify-center pb-20 overflow-x-auto`}
        >
             <div ref={visualizerRef} className="p-4 themed-diagram inline-block rounded-xl">
                 {activeDevices.length > 0 ? (
                     <>
                     <RackVisualizer
                        devices={activeDevices}
                        onMoveDevice={handleMoveDevice}
                        onUpdateConnection={handleConnectionUpdate}
                        pdus={pdus}
                        pduLoads={pduLoads}
                        powerFactor={powerFactor}
                        safetyMargin={safetyMargin}
                        pduPhysicalHeight={pduPhysicalHeight}
                        pduPhysicalWidth={pduPhysicalWidth}
                        pduCordLength={pduCordLength}
                        rackSize={rackSize}
                        voltage={pduSpecs.voltage}
                        circuitCount={pduSpecs.circuits}
                        circuitRating={pduSpecs.amps}
                        isThreePhase={pduSpecs.isThreePhase}
                        pduCols={pduCols}
                     />
                     {/* Interactive side view: drag PDUs/devices between front & back rails */}
                     <div className="mt-6 border-t themed-divider pt-4">
                        <h3 className="text-sm font-bold text-slate-800 mb-2">Side View — Mounting Depth & PDU Placement</h3>
                        <p className="text-[11px] text-slate-500 mb-3 max-w-[720px]">
                            Drag &amp; drop: move components vertically to change their U position, or horizontally between the FRONT (left) and BACK (right) mounting rails. Items follow the cursor exactly from the point you grabbed them.
                            Horizontal PDUs marked with * are manually placed — double-click one to return it to automatic placement. The small white notch on each PDU marks its cable inlet end; the label shows the configured inlet type.
                            Rectangle width shows each item's configured mounting depth drawn to scale. No cables are drawn here — this is a pure space-planning diagram; see the front wiring diagram for cabling.
                            Vertical zero-U PDUs occupy no rack units and hang in the rear L/R cable channels, so they are intentionally not shown here — configure them under PDU Configuration in Global Config and view them in the rear elevation &amp; reports.
                        </p>
                        <div className="overflow-x-auto">
                          <RackSideView
                            devices={activeDevices}
                            pdus={pdus}
                            placement={placement}
                            manualPlacements={manualPlacements}
                            verticalPlacements={verticalPlacements}
                            rackSizeU={rackSize}
                            rackDepthCm={rackDepth}
                            deviceDims={deviceDims}
                            defaultDeviceDim={DEFAULT_DEVICE_DIM}
                            onPlacePdu={handlePlacePdu}
                            onResetPdu={handleResetPduPlacement}
                            onMoveDevice={handleMoveDevice}
                            onSetDeviceSide={handleSetDeviceSide}
                          />
                        </div>
                     </div>
                     </>
                 ) : (
                     <div className="themed-dim mt-20 text-center w-[600px]">No devices loaded. Upload a CSV to begin.</div>
                 )}
             </div>
        </section>

        {/* ============ REPORTS TAB ============ */}
        <section
          role="tabpanel"
          id="tabpanel-reports"
          aria-labelledby="tab-reports"
          className={`${activeTab === 'reports' ? 'block' : 'hidden'} xl:col-span-4`}
        >
            <div className="themed-card border rounded-xl p-6 shadow-lg max-w-4xl">
                <h2 className="text-2xl font-bold themed-heading mb-1">Bill of Materials</h2>
                <p className="text-sm themed-muted mb-6">
                    {activeDevices[0]?.room || 'Rack'} · {activeDevices.length} devices · Max {Math.round(maxLoad)}W / Typical {Math.round(totalLoad)}W
                </p>

                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left border-collapse">
                        <caption className="sr-only">Bill of materials for all rack devices</caption>
                        <thead>
                            <tr className="border-b themed-divider themed-muted uppercase text-xs">
                                <th scope="col" className="py-2 pr-4">Device</th>
                                <th scope="col" className="py-2 pr-4">Room</th>
                                <th scope="col" className="py-2 pr-4 text-right">U Height</th>
                                <th scope="col" className="py-2 pr-4 text-right">PSUs</th>
                                <th scope="col" className="py-2 pr-4">Conn.</th>
                                <th scope="col" className="py-2 pr-4 text-right">Typical (W)</th>
                                <th scope="col" className="py-2 pr-4 text-right">Max (W)</th>
                                <th scope="col" className="py-2">Feed A</th>
                                <th scope="col" className="py-2">Feed B</th>
                            </tr>
                        </thead>
                        <tbody>
                            {activeDevices.map(d => {
                                const conns = Object.values(d.psuConnections).filter(Boolean) as PSUConnection[];
                                const feedA = conns.filter(c => c.pduId.startsWith('A')).map(c => c.pduId).join(', ') || '—';
                                const feedB = conns.filter(c => c.pduId.startsWith('B')).map(c => c.pduId).join(', ') || '—';
                                return (
                                    <tr key={d.id} className="border-b themed-divider last:border-0">
                                        <td className="py-2 pr-4 themed-heading font-medium truncate max-w-[220px]" title={d.name}>{d.name}</td>
                                        <td className="py-2 pr-4 themed-muted">{d.room}</td>
                                        <td className="py-2 pr-4 text-right font-mono">{d.uHeight}U</td>
                                        <td className="py-2 pr-4 text-right font-mono">{d.psuCount}</td>
                                        <td className="py-2 pr-4 themed-muted">{d.connectionType}</td>
                                        <td className="py-2 pr-4 text-right font-mono text-emerald-400">{Math.round(d.typicalPower)}</td>
                                        <td className="py-2 pr-4 text-right font-mono">{Math.round(d.powerRatingPerDevice)}</td>
                                        <td className="py-2 font-mono text-blue-400">{feedA}</td>
                                        <td className="py-2 font-mono text-red-400">{feedB}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                        <tfoot>
                            <tr className="themed-heading font-bold border-t-2 themed-divider">
                                <td className="py-2 pr-4" colSpan={5}>Totals</td>
                                <td className="py-2 pr-4 text-right font-mono text-emerald-400">{Math.round(totalLoad)}</td>
                                <td className="py-2 pr-4 text-right font-mono">{Math.round(maxLoad)}</td>
                                <td className="py-2" colSpan={2}></td>
                            </tr>
                        </tfoot>
                    </table>
                </div>

                <h3 className="text-lg font-bold themed-heading mt-8 mb-3">PDU Load Balance</h3>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left border-collapse">
                        <caption className="sr-only">PDU load balance across all feeds</caption>
                        <thead>
                            <tr className="border-b themed-divider themed-muted uppercase text-xs">
                                <th scope="col" className="py-2 pr-4">PDU</th>
                                <th scope="col" className="py-2 pr-4">Side</th>
                                <th scope="col" className="py-2 pr-4 text-right">Max Load (W)</th>
                                <th scope="col" className="py-2 pr-4 text-right">Capacity (W)</th>
                                <th scope="col" className="py-2">Utilization</th>
                            </tr>
                        </thead>
                        <tbody>
                            {pdus.map(p => {
                                const load = pduLoads[p.id]?.max || 0;
                                const pct = Math.min(100, (load / p.powerCapacity) * 100);
                                const overloaded = load > p.powerCapacity * powerFactor * (safetyMargin / 100);
                                return (
                                    <tr key={p.id} className="border-b themed-divider last:border-0">
                                        <td className="py-2 pr-4 font-mono themed-heading">{p.id}</td>
                                        <td className={`py-2 pr-4 font-mono ${p.side === 'A' ? 'text-blue-400' : 'text-red-400'}`}>{p.side}</td>
                                        <td className={`py-2 pr-4 text-right font-mono ${overloaded ? 'text-red-400 font-bold' : 'themed-muted'}`}>{Math.round(load)}</td>
                                        <td className="py-2 pr-4 text-right font-mono themed-muted">{p.powerCapacity}</td>
                                        <td className="py-2 w-48">
                                            <div className="w-full h-2 themed-input rounded-full overflow-hidden border themed-divider" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${p.id} utilization`}>
                                                <div className={`h-full ${overloaded ? 'bg-red-500' : pct > 80 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }}></div>
                                            </div>
                                            <span className="text-[10px] themed-dim font-mono">{pct.toFixed(1)}%</span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                <div className="mt-8 flex flex-wrap gap-3 no-print">
                    <button onClick={exportPDF} className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded flex items-center gap-2">
                        <FileText size={16} /> Export PDF Diagram
                    </button>
                    <button onClick={exportImage} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded flex items-center gap-2">
                        <FileImage size={16} /> Export PNG
                    </button>
                    <button onClick={exportHTML} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-2">
                        <FileCode size={16} /> Export HTML Report
                    </button>
                    <button onClick={handlePrint} className="px-4 py-2 themed-card border rounded hover:opacity-80 themed-muted flex items-center gap-2">
                        <Printer size={16} /> Print
                    </button>
                </div>
            </div>
        </section>

      </main>

      {/* Group Edit Modal */}
      {editGroupModalOpen && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-label={`Edit device group ${editingType}`}>
              <div className="themed-modal border p-6 rounded-xl shadow-2xl w-full max-w-md">
                  <h3 className="text-xl font-bold themed-heading mb-4">Edit Group: <span className="text-blue-400">{editingType}</span></h3>

                  <div className="space-y-4">
                      <div>
                          <label className="block text-sm themed-muted mb-1" htmlFor="edit-uheight">Rack U Height</label>
                          <select
                            id="edit-uheight"
                            value={editValues.uHeight}
                            onChange={e => setEditValues(prev => ({...prev, uHeight: Number(e.target.value)}))}
                            className="w-full themed-input border themed-divider rounded p-2 themed-heading"
                          >
                              {[1,2,3,4,5,6,7,8,10,14].map(u => <option key={u} value={u}>{u}U</option>)}
                          </select>
                      </div>

                      {/* Physical dimensions (cm) — used by the PDU placement calculator */}
                      <div className="border themed-divider rounded p-3">
                          <div className="text-xs themed-muted uppercase font-bold mb-2">Physical Dimensions (cm)</div>
                          <div className="grid grid-cols-3 gap-2">
                              {(['width', 'height', 'depth'] as const).map((dim) => (
                                  <div key={dim}>
                                      <label className="text-[10px] themed-dim block capitalize" htmlFor={`edit-dim-${dim}`}>{dim}</label>
                                      <input
                                          id={`edit-dim-${dim}`}
                                          type="number" min="0.1" step="0.1"
                                          value={editDims[dim]}
                                          onChange={e => setEditDims(prev => ({ ...prev, [dim]: Math.max(0.1, Number(e.target.value) || 0.1) }))}
                                          className="w-full themed-input border themed-divider rounded p-1.5 text-sm themed-heading"
                                      />
                                  </div>
                              ))}
                          </div>
                          <p className="text-[10px] themed-dim mt-2">
                              If the body height exceeds its U rating, the extra space blocks rack-mount PDU slots above the device.
                          </p>
                      </div>

                      <div>
                          <label className="block text-sm themed-muted mb-1" htmlFor="edit-typical">Typical Power (W)</label>
                          <input
                             id="edit-typical"
                             type="number"
                             value={editValues.typical}
                             onChange={e => setEditValues(prev => ({...prev, typical: Number(e.target.value)}))}
                             className="w-full themed-input border themed-divider rounded p-2 themed-heading"
                          />
                      </div>

                      <div>
                          <label className="block text-sm themed-muted mb-1" htmlFor="edit-max">Max Power Rating (W)</label>
                          <input
                             id="edit-max"
                             type="number"
                             value={editValues.max}
                             onChange={e => setEditValues(prev => ({...prev, max: Number(e.target.value)}))}
                             className="w-full themed-input border themed-divider rounded p-2 themed-heading"
                          />
                      </div>
                  </div>

                  <div className="flex gap-3 mt-8">
                      <button onClick={saveGroupEdit} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-2 rounded flex justify-center items-center gap-2">
                          <Save size={18} /> Save All
                      </button>
                      <button onClick={() => setEditGroupModalOpen(false)} className="flex-1 themed-card border hover:opacity-80 themed-muted py-2 rounded">
                          Cancel
                      </button>
                  </div>
              </div>
          </div>
      )}
    </div>
  );
};

export default Dashboard;
