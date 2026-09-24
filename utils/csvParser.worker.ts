// Web Worker for CSV parsing to keep UI responsive
import { parseCSV } from '../utils/csvParser';

self.onmessage = function(e: MessageEvent<string>) {
  try {
    const csvContent = e.data;
    const devices = parseCSV(csvContent);
    self.postMessage({ success: true, devices });
  } catch (error) {
    self.postMessage({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
};

export {};
