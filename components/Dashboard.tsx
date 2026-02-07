import React, { useState, useRef, useEffect, useMemo } from 'react';
import { parseCSV } from '../utils/csvParser';
import { DEFAULT_CSV, PDU_VARIANTS } from '../constants';
import RackVisualizer from './RackVisualizer';
import { Device, PSUConnection, SocketType, PDUConfig } from '../types';
import { Upload, Settings, Printer, BatteryCharging, Edit3, Save, RotateCcw, Download, FileImage, FileText, FileCode, RefreshCw } from 'lucide-react';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';

// --- Geometry Constants (Must match RackVisualizer) ---
const U_HEIGHT_PX = 30; 
const RACK_HEADER_HEIGHT = 16;

const PDU_HEADER_H = 40;
const PDU_FOOTER_H = 40;
const SOCKET_H = 14; 
const SOCKET_GAP = 4;
const SOCKET_PADDING = 8;
const PDU_VERTICAL_GAP = 20;

const Dashboard: React.FC = () => {
  const [csvInput, setCsvInput] = useState(DEFAULT_CSV);
  
  // Active Room State
  const [activeDevices, setActiveDevices] = useState<Device[]>([]);

  // Configuration
  const [rackSize, setRackSize] = useState(48);
  const [tempRackSize, setTempRackSize] = useState<number | string>(48);

  const [baseSocketsPerPDU, setBaseSocketsPerPDU] = useState(20);
  const [tempSockets, setTempSockets] = useState<number | string>(20); 

  const [secondarySocketsPerPDU, setSecondarySocketsPerPDU] = useState(4);
  const [tempSecondarySockets, setTempSecondarySockets] = useState<number | string>(4);

  const [pduPhysicalHeight, setPduPhysicalHeight] = useState<number>(180); // cm
  const [pduPhysicalWidth, setPduPhysicalWidth] = useState<number>(5.5); // cm
  const [pduCordLength, setPduCordLength] = useState<number>(3); // meters

  const [basePduCapacity, setBasePduCapacity] = useState(7360);
  const [safetyMargin, setSafetyMargin] = useState(80);
  const [powerFactor, setPowerFactor] = useState(0.95);
  
  const [socketType, setSocketType] = useState<SocketType>('C13');
  const [secondarySocketType, setSecondarySocketType] = useState<SocketType>('C19');
  
  // Group Editing State
  const [editGroupModalOpen, setEditGroupModalOpen] = useState(false);
  const [deviceTypes, setDeviceTypes] = useState<string[]>([]);
  const [editingType, setEditingType] = useState<string>('');
  const [editValues, setEditValues] = useState({ uHeight: 1, typical: 0, max: 0 });
  
  // UI State
  const [showExportMenu, setShowExportMenu] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const visualizerRef = useRef<HTMLDivElement>(null);

  // --- Logic to Calculate Required PDUs ---
  
  const requiredPduPairs = useMemo(() => {
    const totalMaxPower = activeDevices.reduce((sum, d) => sum + d.powerRatingPerDevice, 0);
    const totalPSUs = activeDevices.reduce((sum, d) => sum + d.psuCount, 0);
    
    // Effective capacity per side (A or B) taking redundancy into account.
    const effectiveCapacity = basePduCapacity * powerFactor * (safetyMargin / 100);
    
    // Power Requirement (Ceil) -> Added 15% buffer for bin-packing inefficiencies
    const pairsByPower = Math.ceil((totalMaxPower * 1.15) / effectiveCapacity);
    
    // Socket Requirement (Total sockets = base + secondary)
    const totalSocketsPerPDU = baseSocketsPerPDU + secondarySocketsPerPDU;
    const pairsBySockets = Math.ceil((totalPSUs / 2) / totalSocketsPerPDU);
    
    return Math.max(1, pairsByPower, pairsBySockets);
  }, [activeDevices, basePduCapacity, powerFactor, safetyMargin, baseSocketsPerPDU, secondarySocketsPerPDU]);

  // Generate the PDU Definitions based on the calculated requirement
  const pdus: PDUConfig[] = useMemo(() => {
    const list: PDUConfig[] = [];
    for (let i = 0; i < requiredPduPairs; i++) {
        const configA: PDUConfig = {
            id: `A${i+1}`,
            side: 'A',
            index: i,
            socketType: socketType,
            socketCount: baseSocketsPerPDU,
            secondarySocketType: secondarySocketType,
            secondarySocketCount: secondarySocketsPerPDU,
            powerCapacity: basePduCapacity
        };
        const configB: PDUConfig = {
            id: `B${i+1}`,
            side: 'B',
            index: i,
            socketType: socketType,
            socketCount: baseSocketsPerPDU,
            secondarySocketType: secondarySocketType,
            secondarySocketCount: secondarySocketsPerPDU,
            powerCapacity: basePduCapacity
        };
        list.push(configA);
        list.push(configB);
    }
    return list;
  }, [requiredPduPairs, baseSocketsPerPDU, secondarySocketsPerPDU, basePduCapacity, socketType, secondarySocketType]);


  // Helper: Get geometric center Y of a PDU pair
  const getPduCenterY = (index: number, numPairs: number, totalSocketsPerPDU: number, rackSizeU: number) => {
      const getPDUHeight = (socketCount: number) => {
          const contentH = (socketCount * SOCKET_H) + ((socketCount - 1) * SOCKET_GAP);
          return PDU_HEADER_H + SOCKET_PADDING + contentH + SOCKET_PADDING + PDU_FOOTER_H;
      };
      const singlePduHeight = getPDUHeight(totalSocketsPerPDU);
      const totalGroupHeight = (numPairs * singlePduHeight) + ((numPairs - 1) * PDU_VERTICAL_GAP);
      
      const rackHeightPx = (rackSizeU * U_HEIGHT_PX) + (RACK_HEADER_HEIGHT * 2);
      const startY = Math.max(0, (rackHeightPx - totalGroupHeight) / 2);

      const y = startY + index * (singlePduHeight + PDU_VERTICAL_GAP);
      return y + (singlePduHeight / 2);
  };

  // Initial Load & Auto-Patching when CSV changes
  useEffect(() => {
    const groups = parseCSV(csvInput);
    if (groups.length > 0) {
      let devices = groups[0].devices;
      
      const effectiveCap = basePduCapacity * powerFactor * (safetyMargin / 100);
      const totalSocketsPerPDU = baseSocketsPerPDU + secondarySocketsPerPDU;

      // 1. Determine how many PDUs we will likely have (Estimation)
      const totalMaxPower = devices.reduce((sum, d) => sum + d.powerRatingPerDevice, 0);
      const totalPSUs = devices.reduce((sum, d) => sum + d.psuCount, 0);
      
      const pairsByPower = Math.ceil((totalMaxPower * 1.15) / effectiveCap);
      const pairsBySockets = Math.ceil((totalPSUs / 2) / totalSocketsPerPDU);
      const numPairs = Math.max(1, pairsByPower, pairsBySockets);

      // 2. Initialize PDU State with geometric info
      const pduState: Record<string, { 
          currentLoad: number, 
          nextSocket: number, 
          centerY: number,
          id: string
      }> = {};
      
      for(let i=0; i < numPairs; i++) {
          const cy = getPduCenterY(i, numPairs, totalSocketsPerPDU, rackSize);
          pduState[`A${i+1}`] = { currentLoad: 0, nextSocket: 0, centerY: cy, id: `A${i+1}` };
          pduState[`B${i+1}`] = { currentLoad: 0, nextSocket: 0, centerY: cy, id: `B${i+1}` };
      }

      // 3. Assign Devices (Auto-Patch to Closest)
      // Adjust positions for CSV import based on rack size (simple stack down from top)
      let currentU = rackSize;
      const positionedDevices = devices.map(d => {
           // We are re-stacking here to ensure it fits the new rack size
           if (currentU - d.uHeight + 1 >= 1) {
                const pos = currentU;
                currentU -= d.uHeight;
                return { ...d, uPosition: pos };
           }
           return { ...d, uPosition: null };
      });

      const finalDevices = positionedDevices.map(d => {
          const newConns: any = {};
          
          if (!d.uPosition) return { ...d, psuConnections: {} };

          const uPos = d.uPosition; 
          const topPx = RACK_HEADER_HEIGHT + ((rackSize - uPos) * U_HEIGHT_PX);
          const deviceCenterY = topPx + ((d.uHeight * U_HEIGHT_PX) / 2);

          const loadToAdd = d.powerRatingPerDevice; 

          for(let i=0; i<d.psuCount; i++) {
              const isEven = i % 2 === 0;
              const side = isEven ? 'A' : 'B';
              
              const candidates = [];
              for(let k=0; k<numPairs; k++) {
                  candidates.push(pduState[`${side}${k+1}`]);
              }

              // Sort by distance
              candidates.sort((a, b) => Math.abs(a.centerY - deviceCenterY) - Math.abs(b.centerY - deviceCenterY));
              
              let assigned = false;
              for (const pdu of candidates) {
                  // Check limits (Total sockets)
                  if (pdu.nextSocket < totalSocketsPerPDU && pdu.currentLoad + loadToAdd <= effectiveCap) {
                      newConns[i] = {
                          pduId: pdu.id,
                          socketIndex: pdu.nextSocket
                      };
                      
                      pdu.nextSocket++;
                      pdu.currentLoad += loadToAdd;
                      assigned = true;
                      break;
                  }
              }
              
              if (!assigned) {
                  newConns[i] = null;
              }
          }
          return { ...d, psuConnections: newConns };
      });

      setActiveDevices(finalDevices);
      updateDeviceTypes(finalDevices);
    }
  }, [csvInput, basePduCapacity, baseSocketsPerPDU, secondarySocketsPerPDU, powerFactor, safetyMargin, rackSize]); 

  const updateDeviceTypes = (devices: Device[]) => {
      const types = Array.from(new Set(devices.map(d => d.name)));
      setDeviceTypes(types);
  };

  // --- Handlers ---

  const handleAutoConnect = () => {
    // Uses current activeDevices and current configuration to re-run connection logic
    const effectiveCap = basePduCapacity * powerFactor * (safetyMargin / 100);
    const totalSocketsPerPDU = baseSocketsPerPDU + secondarySocketsPerPDU;
    
    // We reuse the calculated 'pdus' array to know how many pairs we have currently
    const numPairs = pdus.length / 2;

    // 1. Initialize PDU State
    const pduState: Record<string, { 
          currentLoad: number, 
          nextSocket: number, 
          centerY: number,
          id: string
    }> = {};

    for(let i=0; i < numPairs; i++) {
        const cy = getPduCenterY(i, numPairs, totalSocketsPerPDU, rackSize);
        pduState[`A${i+1}`] = { currentLoad: 0, nextSocket: 0, centerY: cy, id: `A${i+1}` };
        pduState[`B${i+1}`] = { currentLoad: 0, nextSocket: 0, centerY: cy, id: `B${i+1}` };
    }

    // 2. Sort devices by U Position (Descending) to ensure wires don't cross (Top device -> Top Socket)
    // Create a copy to sort
    const devicesProcessList = [...activeDevices].sort((a, b) => {
        // Unmounted devices go last
        if (!a.uPosition && !b.uPosition) return 0;
        if (!a.uPosition) return 1;
        if (!b.uPosition) return -1;
        // Higher U position first
        return b.uPosition - a.uPosition;
    });

    // 3. Assign Devices (Auto-Patch to Closest)
    const finalDevices = devicesProcessList.map(d => {
        const newConns: any = {};
        
        if (!d.uPosition) {
            // Keep it unconnected if not mounted
            return { ...d, psuConnections: {} }; 
        }

        const uPos = d.uPosition; 
        const topPx = RACK_HEADER_HEIGHT + ((rackSize - uPos) * U_HEIGHT_PX);
        const deviceCenterY = topPx + ((d.uHeight * U_HEIGHT_PX) / 2);

        const loadToAdd = d.powerRatingPerDevice; 

        for(let i=0; i<d.psuCount; i++) {
            const isEven = i % 2 === 0;
            const side = isEven ? 'A' : 'B';
            
            const candidates = [];
            for(let k=0; k<numPairs; k++) {
                candidates.push(pduState[`${side}${k+1}`]);
            }

            // Sort by distance
            candidates.sort((a, b) => Math.abs(a.centerY - deviceCenterY) - Math.abs(b.centerY - deviceCenterY));
            
            let assigned = false;
            for (const pdu of candidates) {
                if (pdu.nextSocket < totalSocketsPerPDU && pdu.currentLoad + loadToAdd <= effectiveCap) {
                    newConns[i] = {
                        pduId: pdu.id,
                        socketIndex: pdu.nextSocket
                    };
                    
                    pdu.nextSocket++;
                    pdu.currentLoad += loadToAdd;
                    assigned = true;
                    break;
                }
            }
            
            if (!assigned) {
                newConns[i] = null;
            }
        }
        return { ...d, psuConnections: newConns };
    });

    setActiveDevices(finalDevices);
  };

  const handleApplyRackSize = () => {
    const val = Number(tempRackSize);
    if (!isNaN(val) && val >= 4 && val <= 52) {
        setRackSize(Math.floor(val));
    } else {
        alert("Please enter a valid integer between 4 and 52.");
        setTempRackSize(rackSize);
    }
  };

  const handleApplySockets = () => {
    const val = Number(tempSockets);
    if (!isNaN(val) && val >= 1 && val <= 32) {
        setBaseSocketsPerPDU(Math.floor(val));
    } else {
        alert("Please enter a valid integer between 1 and 32.");
        setTempSockets(baseSocketsPerPDU);
    }
  };

  const handleApplySecondarySockets = () => {
    const val = Number(tempSecondarySockets);
    if (!isNaN(val) && val >= 0 && val <= 16) {
        setSecondarySocketsPerPDU(Math.floor(val));
    } else {
        alert("Please enter a valid integer between 0 and 16.");
        setTempSecondarySockets(secondarySocketsPerPDU);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        if (evt.target?.result) setCsvInput(evt.target.result as string);
        if (fileInputRef.current) fileInputRef.current.value = '';
      };
      reader.readAsText(file);
    }
  };

  const handleReset = () => {
      setCsvInput(DEFAULT_CSV);
      setTempSockets(20);
      setBaseSocketsPerPDU(20);
      setTempSecondarySockets(4);
      setSecondarySocketsPerPDU(4);
      setRackSize(48);
      setTempRackSize(48);
  };
  
  const handleDownloadTemplate = () => {
    const blob = new Blob([DEFAULT_CSV], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'rack_import_template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handlePrint = () => window.print();

  // Export Logic (Same as before)
  const captureVisualizer = async () => {
      if (!visualizerRef.current) return null;
      try {
          const dataUrl = await toPng(visualizerRef.current, {
              backgroundColor: '#ffffff',
              pixelRatio: 2,
          });
          return dataUrl;
      } catch (err) {
          console.error("Export failed", err);
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
                                <td>${d.name}</td>
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
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'rack_report.html';
      link.click();
      setShowExportMenu(false);
  };

  // Move Device Logic
  const handleMoveDevice = (id: string, targetU: number) => {
    setActiveDevices(prev => {
        const device = prev.find(d => d.id === id);
        if (!device) return prev;
        if (targetU > rackSize) return prev;
        if (targetU - device.uHeight + 1 < 1) return prev;
        const isCollision = prev.some(d => {
            if (d.id === id) return false;
            if (!d.uPosition) return false;
            const dTop = d.uPosition;
            const dBottom = d.uPosition - d.uHeight + 1;
            const targetTop = targetU;
            const targetBottom = targetU - device.uHeight + 1;
            return (targetTop >= dBottom && targetBottom <= dTop);
        });
        if (isCollision) return prev;
        return prev.map(d => d.id === id ? { ...d, uPosition: targetU } : d);
    });
  };

  // Connection Logic
  const handleConnectionUpdate = (
      deviceId: string, 
      psuIndex: number, 
      pduId: string | null, 
      socketIndex: number|null
  ) => {
      setActiveDevices(prev => {
          if (pduId !== null && socketIndex !== null) {
              const isOccupied = prev.some(d => 
                  Object.values(d.psuConnections).some((c) => {
                    const conn = c as PSUConnection | null;
                    return conn && conn.pduId === pduId && conn.socketIndex === socketIndex;
                  })
              );
              if (isOccupied) return prev;
          }
          return prev.map(d => {
              if (d.id === deviceId) {
                  const newConns = { ...d.psuConnections };
                  if (pduId === null) {
                      newConns[psuIndex] = null;
                  } else {
                      newConns[psuIndex] = { pduId, socketIndex: socketIndex! };
                  }
                  return { ...d, psuConnections: newConns };
              }
              return d;
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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-8">
      {/* Header */}
      <header className="max-w-[1920px] mx-auto mb-6 flex flex-col md:flex-row justify-between items-center gap-4 no-print">
        <div>
           <h1 className="text-3xl font-bold text-white tracking-tight">Rack Power Architect</h1>
           <p className="text-slate-400 mt-1">Interactive Layout & Power Planning</p>
        </div>
        <div className="flex gap-2 relative">
             <button onClick={handleAutoConnect} className="px-3 py-2 bg-orange-700 rounded border border-orange-600 hover:bg-orange-600 text-white flex items-center gap-2" title="Recalculate wiring based on current positions">
                 <RefreshCw size={16} /> Recalculate Wiring
             </button>

             <button onClick={handleReset} className="px-3 py-2 bg-slate-800 rounded border border-slate-700 hover:bg-slate-700 flex items-center gap-2">
                 <RotateCcw size={16} /> Reset
             </button>

             <button onClick={handleDownloadTemplate} className="px-3 py-2 bg-slate-800 rounded border border-slate-700 hover:bg-slate-700 flex items-center gap-2 text-slate-300" title="Download CSV Template">
                 <FileText size={16} /> Template
             </button>
             
             <label className="px-3 py-2 bg-blue-600 rounded cursor-pointer hover:bg-blue-500 text-white flex items-center gap-2">
                 <Upload size={16} /> Upload CSV
                 <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
             </label>
             
             <div className="relative">
                 <button 
                    onClick={() => setShowExportMenu(!showExportMenu)} 
                    className="px-3 py-2 bg-emerald-600 rounded hover:bg-emerald-500 text-white flex items-center gap-2"
                 >
                     <Download size={16} /> Export
                 </button>
                 {showExportMenu && (
                     <div className="absolute right-0 mt-2 w-48 bg-white text-slate-900 rounded-lg shadow-xl z-50 overflow-hidden border border-slate-200">
                         <button onClick={exportImage} className="w-full text-left px-4 py-3 hover:bg-slate-100 flex items-center gap-2 border-b border-slate-100">
                             <FileImage size={16} className="text-emerald-600" /> Save as Image (PNG)
                         </button>
                         <button onClick={exportPDF} className="w-full text-left px-4 py-3 hover:bg-slate-100 flex items-center gap-2 border-b border-slate-100">
                             <FileText size={16} className="text-red-600" /> Save as PDF
                         </button>
                         <button onClick={exportHTML} className="w-full text-left px-4 py-3 hover:bg-slate-100 flex items-center gap-2">
                             <FileCode size={16} className="text-blue-600" /> Save as Report (HTML)
                         </button>
                         <button onClick={handlePrint} className="w-full text-left px-4 py-3 hover:bg-slate-100 flex items-center gap-2 border-t border-slate-100 bg-slate-50 text-slate-500">
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

      <main className="max-w-[1920px] mx-auto grid grid-cols-1 xl:grid-cols-5 gap-8">
        
        <aside className="xl:col-span-1 space-y-6 no-print h-fit sticky top-4">
            {/* Global Config */}
            <div className="bg-slate-900 p-5 rounded-xl border border-slate-800 shadow-lg">
                <h3 className="font-bold text-white mb-4 flex items-center gap-2"><Settings size={18} /> Global Config</h3>
                <div className="space-y-4">
                    
                    {/* Rack Size */}
                    <div className="border-b border-slate-700 pb-3">
                        <label className="text-xs text-slate-400 uppercase font-bold">Rack Size (U)</label>
                        <div className="flex gap-2 mt-1 mb-2">
                            <input 
                                type="number" min="4" max="52" 
                                value={tempRackSize} onChange={e => setTempRackSize(e.target.value)}
                                className="w-full bg-slate-800 border border-slate-700 rounded p-2"
                            />
                            <button onClick={handleApplyRackSize} className="bg-blue-600 hover:bg-blue-500 text-white px-2 rounded text-xs font-bold">SET</button>
                        </div>
                    </div>

                    {/* Primary Sockets */}
                    <div className="border-b border-slate-700 pb-3">
                        <label className="text-xs text-slate-400 uppercase font-bold">Group 1: Sockets</label>
                        <div className="flex gap-2 mt-1 mb-2">
                            <input 
                                type="number" min="1" max="32" 
                                value={tempSockets} onChange={e => setTempSockets(e.target.value)}
                                className="w-full bg-slate-800 border border-slate-700 rounded p-2"
                            />
                            <button onClick={handleApplySockets} className="bg-blue-600 hover:bg-blue-500 text-white px-2 rounded text-xs font-bold">SET</button>
                        </div>
                        <select 
                            value={socketType} onChange={e => setSocketType(e.target.value as SocketType)}
                            className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-sm"
                        >
                            <option value="UK">UK (Type G)</option>
                            <option value="C13">C13 (IEC)</option>
                            <option value="C19">C19 (IEC)</option>
                        </select>
                    </div>

                    {/* Secondary Sockets */}
                    <div className="border-b border-slate-700 pb-3">
                        <label className="text-xs text-slate-400 uppercase font-bold">Group 2: Sockets</label>
                        <div className="flex gap-2 mt-1 mb-2">
                            <input 
                                type="number" min="0" max="16" 
                                value={tempSecondarySockets} onChange={e => setTempSecondarySockets(e.target.value)}
                                className="w-full bg-slate-800 border border-slate-700 rounded p-2"
                            />
                            <button onClick={handleApplySecondarySockets} className="bg-blue-600 hover:bg-blue-500 text-white px-2 rounded text-xs font-bold">SET</button>
                        </div>
                        <select 
                            value={secondarySocketType} onChange={e => setSecondarySocketType(e.target.value as SocketType)}
                            className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-sm"
                        >
                            <option value="UK">UK (Type G)</option>
                            <option value="C13">C13 (IEC)</option>
                            <option value="C19">C19 (IEC)</option>
                        </select>
                    </div>

                    <div>
                        <label className="text-xs text-slate-400 uppercase font-bold">PDU Rating</label>
                        <select 
                            value={basePduCapacity} onChange={e => setBasePduCapacity(Number(e.target.value))}
                            className="w-full bg-slate-800 border border-slate-700 rounded p-2 mt-1"
                        >
                            {PDU_VARIANTS.map(v => <option key={v.power} value={v.power}>{v.name}</option>)}
                        </select>
                    </div>
                    
                    {/* PDU Physical Specs */}
                    <div>
                        <label className="text-xs text-slate-400 uppercase font-bold">PDU Dimensions</label>
                        <div className="grid grid-cols-2 gap-2 mt-1">
                            <div>
                                <span className="text-[10px] text-slate-500 block">Height (cm)</span>
                                <input 
                                    type="number" min="1" 
                                    value={pduPhysicalHeight} onChange={e => setPduPhysicalHeight(Number(e.target.value))}
                                    className="w-full bg-slate-800 border border-slate-700 rounded p-2"
                                />
                            </div>
                            <div>
                                <span className="text-[10px] text-slate-500 block">Width (cm)</span>
                                <input 
                                    type="number" min="1" 
                                    value={pduPhysicalWidth} onChange={e => setPduPhysicalWidth(Number(e.target.value))}
                                    className="w-full bg-slate-800 border border-slate-700 rounded p-2"
                                />
                            </div>
                        </div>
                    </div>
                    <div>
                        <label className="text-xs text-slate-400 uppercase font-bold">Cord Length (m)</label>
                        <input 
                            type="number" min="0.5" step="0.5" 
                            value={pduCordLength} onChange={e => setPduCordLength(Number(e.target.value))}
                            className="w-full bg-slate-800 border border-slate-700 rounded p-2 mt-1"
                        />
                    </div>


                    <div>
                         <label className="text-xs text-slate-400 uppercase font-bold flex justify-between">
                            <span>Power Factor</span> <span>{powerFactor}</span>
                         </label>
                         <input type="range" min="0.5" max="1" step="0.01" value={powerFactor} onChange={e => setPowerFactor(Number(e.target.value))} className="w-full accent-emerald-500"/>
                    </div>
                </div>
            </div>

            {/* Device Group Editor */}
            <div className="bg-slate-900 p-5 rounded-xl border border-slate-800 shadow-lg">
                <h3 className="font-bold text-white mb-4 flex items-center gap-2"><Edit3 size={18} /> Device Library</h3>
                <div className="flex flex-col gap-2 max-h-60 overflow-y-auto pr-2">
                    {deviceTypes.map(type => (
                        <button 
                            key={type}
                            onClick={() => openGroupEditor(type)}
                            className="text-left text-sm p-2 bg-slate-800 hover:bg-slate-700 rounded border border-slate-700 truncate"
                        >
                            {type}
                        </button>
                    ))}
                </div>
            </div>

            {/* Stats Summary */}
             <div className="bg-slate-900 p-5 rounded-xl border border-slate-800 shadow-lg">
                 <h3 className="font-bold text-white mb-4 flex items-center gap-2"><BatteryCharging size={18} /> Summary</h3>
                 <div className="flex justify-between items-center">
                    <span className="text-sm text-slate-400">Total Max Load</span>
                    <span className="text-xl font-mono font-bold text-white">{Math.round(maxLoad)}W</span>
                 </div>
                 <div className="flex justify-between items-center mt-1">
                    <span className="text-sm text-slate-400">Total Typical</span>
                    <span className="text-md font-mono text-emerald-400">{Math.round(totalLoad)}W</span>
                 </div>
                 <div className="mt-4 pt-4 border-t border-slate-700 text-xs text-slate-500">
                    Required PDUs: {requiredPduPairs} pair(s) based on capacity & sockets.
                 </div>
             </div>
        </aside>

        {/* Rack Visualization Area */}
        <section className="xl:col-span-4 flex justify-center pb-20 overflow-x-auto">
             <div ref={visualizerRef} className="p-4 bg-slate-950 inline-block rounded-xl">
                 {activeDevices.length > 0 ? (
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
                     />
                 ) : (
                     <div className="text-slate-500 mt-20 text-center w-[600px]">No devices loaded. Upload a CSV to begin.</div>
                 )}
             </div>
        </section>

      </main>

      {/* Group Edit Modal */}
      {editGroupModalOpen && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
              <div className="bg-slate-900 p-6 rounded-xl border border-slate-700 shadow-2xl w-full max-w-md">
                  <h3 className="text-xl font-bold text-white mb-4">Edit Group: <span className="text-blue-400">{editingType}</span></h3>
                  
                  <div className="space-y-4">
                      <div>
                          <label className="block text-sm text-slate-400 mb-1">Rack U Height</label>
                          <select 
                            value={editValues.uHeight}
                            onChange={e => setEditValues(prev => ({...prev, uHeight: Number(e.target.value)}))}
                            className="w-full bg-slate-800 border border-slate-600 rounded p-2 text-white"
                          >
                              {[1,2,3,4,5,6,7,8,10,14].map(u => <option key={u} value={u}>{u}U</option>)}
                          </select>
                      </div>
                      
                      <div>
                          <label className="block text-sm text-slate-400 mb-1">Typical Power (W)</label>
                          <input 
                             type="number" 
                             value={editValues.typical}
                             onChange={e => setEditValues(prev => ({...prev, typical: Number(e.target.value)}))}
                             className="w-full bg-slate-800 border border-slate-600 rounded p-2 text-white"
                          />
                      </div>

                      <div>
                          <label className="block text-sm text-slate-400 mb-1">Max Power Rating (W)</label>
                          <input 
                             type="number" 
                             value={editValues.max}
                             onChange={e => setEditValues(prev => ({...prev, max: Number(e.target.value)}))}
                             className="w-full bg-slate-800 border border-slate-600 rounded p-2 text-white"
                          />
                      </div>
                  </div>

                  <div className="flex gap-3 mt-8">
                      <button onClick={saveGroupEdit} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-2 rounded flex justify-center items-center gap-2">
                          <Save size={18} /> Save All
                      </button>
                      <button onClick={() => setEditGroupModalOpen(false)} className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 py-2 rounded">
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
