
import { Device, RackGroup } from '../types';

export const parseCSV = (csvText: string): RackGroup[] => {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  // Robust CSV Line Parser
  const parseLine = (text: string) => {
    const result: string[] = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === ',' && !inQuotes) {
        result.push(cell.trim());
        cell = '';
      } else cell += char;
    }
    result.push(cell.trim());
    return result;
  };

  const headers = parseLine(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
  
  // Helper to find column index with multiple keywords
  const getColIndex = (keywords: string[]) => 
    headers.findIndex(h => keywords.some(k => h.toLowerCase().includes(k.toLowerCase())));

  const idxRoom = getColIndex(['Room', 'Location', 'Rack Name']);
  const idxDevice = getColIndex(['Device', 'Model', 'Equipment']);
  const idxRackU = getColIndex(['Rack Size', 'Size (U)', 'U Height', 'Height']);
  const idxQty = getColIndex(['Total No. of Device', 'Quantity', 'Qty', 'Count', 'No. of Devices']);
  const idxPSCount = getColIndex(['Total No. of PS', 'PSU Count', 'Power Supplies']);
  const idxMaxPowerPerDevice = getColIndex(['Max Power (Watt)', 'Max Power', 'Power (W)']);
  const idxTypicalPower = getColIndex(['Typical Power', 'Typical Load']);
  const idxTotalMaxPower = getColIndex(['Total Max Power Consumption', 'Total Power']);
  const idxConnType = getColIndex(['Connection Type', 'Plug Type', 'Socket']);
  const idxPSURating = getColIndex(['PSU Rating', 'PSU W', 'Power Supply Rating']);

  const racksMap = new Map<string, Device[]>();
  let lastRoom = 'Default Room';

  for (let i = 1; i < lines.length; i++) {
    const row = parseLine(lines[i]);
    if (row.length < headers.length * 0.5 && row.length < 2) continue; // Skip empty lines

    // Room Logic: Implement "Fill Down" behavior for empty cells
    let room = lastRoom;
    if (idxRoom !== -1) {
        const val = row[idxRoom];
        if (val && val.replace(/^"|"$/g, '').trim().length > 0) {
            room = val.replace(/^"|"$/g, '').trim();
            lastRoom = room;
        } 
        // If empty, it stays as lastRoom (Fill Down)
    } else {
        // If no Room column exists, use Default Room for all
        room = 'Default Room';
    }

    const deviceName = idxDevice !== -1 ? (row[idxDevice]?.replace(/^"|"$/g, '') || 'Unknown Device') : 'Unknown Device';
    
    // Quantity Parsing
    let qty = 1;
    if (idxQty !== -1) {
        const parsed = parseInt(row[idxQty]);
        if (!isNaN(parsed) && parsed > 0) qty = parsed;
    }

    // PSU Count Parsing
    let psCountTotal = qty; // Default 1 per device
    if (idxPSCount !== -1) {
        const parsed = parseInt(row[idxPSCount]);
        if (!isNaN(parsed) && parsed > 0) psCountTotal = parsed;
    }
    const psPerDevice = Math.max(1, Math.floor(psCountTotal / qty));
    
    // U Height parsing
    let uHeight = 1;
    if (idxRackU !== -1) {
      const rawU = parseInt(row[idxRackU]);
      if (!isNaN(rawU) && rawU > 0) {
        uHeight = rawU;
      }
    }

    // Power Calc
    let maxPower = 0;
    const rawMax = idxMaxPowerPerDevice !== -1 ? parseFloat(row[idxMaxPowerPerDevice]) : NaN;
    const rawTotal = idxTotalMaxPower !== -1 ? parseFloat(row[idxTotalMaxPower]) : NaN;
    const rawRating = idxPSURating !== -1 ? parseFloat(row[idxPSURating]) : NaN;

    if (!isNaN(rawMax) && rawMax > 0) maxPower = rawMax;
    else if (!isNaN(rawTotal) && rawTotal > 0) maxPower = rawTotal / qty;
    else if (!isNaN(rawRating)) maxPower = rawRating * psPerDevice;

    let typicalPower = idxTypicalPower !== -1 ? parseFloat(row[idxTypicalPower]) : NaN;
    if (isNaN(typicalPower)) typicalPower = maxPower * 0.6; // Default to 60% if missing

    const connectionType = idxConnType !== -1 ? (row[idxConnType]?.replace(/^"|"$/g, '') || 'C13') : 'C13';

    for (let k = 0; k < qty; k++) {
      const device: Device = {
        id: `${room}-${deviceName}-${i}-${k}`.replace(/\s+/g, '-'),
        name: deviceName,
        room,
        psuCount: psPerDevice,
        typicalPower: typicalPower,
        powerRatingPerDevice: maxPower,
        connectionType: connectionType,
        uHeight: uHeight,
        uPosition: null, // Assigned later
        psuConnections: {}
      };

      if (!racksMap.has(room)) racksMap.set(room, []);
      racksMap.get(room)?.push(device);
    }
  }

  const result: RackGroup[] = [];
  racksMap.forEach((devices, roomId) => {
    // Auto-stack logic: Start from U42 going down
    // We use U45 as top to leave space for patch panels/PDUs if needed, or just U48 max.
    // Let's use U48 down to 1.
    let currentU = 48;
    
    // Assign positions
    const positionedDevices = devices.map(d => {
      // Check if it fits
      if (currentU - d.uHeight + 1 >= 1) {
        const pos = currentU;
        currentU -= d.uHeight;
        
        // Initialize empty connections
        const conns: any = {};
        for(let p=0; p<d.psuCount; p++) {
             conns[p] = null;
        }

        return { ...d, uPosition: pos, psuConnections: conns };
      }
      
      // Device doesn't fit in rack
      return { ...d, uPosition: null, psuConnections: {} }; 
    });

    const totalPower = positionedDevices.reduce((sum, d) => sum + d.powerRatingPerDevice, 0);
    result.push({ roomId, devices: positionedDevices, totalPower });
  });

  return result;
};
