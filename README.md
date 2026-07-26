<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# PDU Power Planner

A powerful React-based web application for planning, visualizing, and managing Power Distribution Unit (PDU) configurations in data center racks. This tool helps you organize devices, calculate power consumption, and generate professional documentation for your rack setups.

## Features

- **Rack Visualization**: Interactive visual representation of your server racks with device placement
- **PDU Configuration**: Configure primary and secondary PDUs with customizable socket types (C13, C19, etc.)
- **Power Management**: Track device power consumption with safety margins and power factor calculations
- **CSV Import**: Import device configurations via CSV format for bulk data entry
- **Export Capabilities**: 
  - Export rack diagrams as PNG images
  - Generate PDF reports
  - Export configuration as JSON
- **Customizable Settings**: Adjust rack size, PDU columns, socket types, and physical dimensions
- **Real-time Calculations**: Automatic power capacity and utilization calculations

## Tech Stack

- **React 19** - UI framework
- **TypeScript** - Type-safe development
- **Vite** - Build tool and dev server
- **Lucide React** - Icon library
- **html-to-image** - Screenshot generation
- **jsPDF** - PDF report generation
- **jspdf** - Document creation

## Prerequisites

- Node.js (v18 or higher recommended)
- npm or yarn package manager

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd pdu-power-planner
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. (Optional) Set up environment variables:
   Create a `.env.local` file if you need API integrations:
   ```
   GEMINI_API_KEY=your_api_key_here
   ```

## Usage

### Development Mode

Start the development server:

```bash
npm run dev
```

The application will open at `http://localhost:5173` (or the next available port).

### Production Build

Build the application for production:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Input Format

### CSV Structure

The application accepts CSV data with the following columns:

| Column | Description |
|--------|-------------|
| Room | Rack room identifier |
| Device | Device name/model |
| Rack Size (U) | Rack unit size (1U, 2U, etc.) |
| Total No. of Device | Number of devices |
| Total No. of PS | Number of power supplies per device |
| PSU Rating (Watt) | Power supply rating in watts |
| Typical Power (Watt) | Typical power consumption |
| Max Power (Watt) | Maximum power consumption |
| Total Max Power Consumption (Watt) | Total max power for all devices |
| Power Connection Type | Socket type (C13, C19, etc.) |

Example:
```csv
Room,Device,Rack Size (U),Total No. of Device,Total No. of PS,PSU Rating (Watt),Typical Power (Watt),Max Power (Watt),Total Max Power Consumption (Watt),Power Connection Type
MG3_RACK_03,Cisco Nexus C93180YC-FX3,1,4,8,650,,600,2400,C13
MG3_RACK_03,HPE ProLiant DL380 Gen10,2,2,4,,,1600,3200,C13
```

## Configuration Options

### Rack Settings
- **Rack Size**: Configure total rack units (default: 48U)
- **PDU Columns**: Set number of PDU columns for display

### PDU Settings
- **Primary PDU**: Main power distribution with configurable sockets
- **Secondary PDU**: Backup/secondary power distribution
- **Socket Types**: Choose between C13, C19, or other standard socket types
- **Physical Dimensions**: Set PDU height, width, and cord length

### Power Settings
- **Base PDU Capacity**: Maximum power capacity (default: 7360W)
- **Safety Margin**: Percentage buffer for safety (default: 80%)
- **Power Factor**: Efficiency factor for calculations (default: 0.95)

## Export Options

1. **PNG Image**: Download high-quality screenshot of your rack layout
2. **PDF Report**: Generate comprehensive PDF documentation
3. **JSON Config**: Export current configuration for backup or sharing

## Project Structure

```
pdu-power-planner/
├── components/
│   ├── Dashboard.tsx      # Main dashboard component
│   ├── RackVisualizer.tsx # Rack visualization component
│   └── WiringDiagram.tsx  # Wiring diagram component
├── utils/
│   └── csvParser.ts       # CSV parsing utilities
├── constants.ts           # Application constants
├── types.ts               # TypeScript type definitions
├── App.tsx                # Root application component
├── index.tsx              # Application entry point
└── vite.config.ts         # Vite configuration
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |

## License

This project is private and proprietary.

## Support

For issues or questions, please refer to the AI Studio app page: https://ai.studio/apps/drive/1OhqJ0wCE_rMCJJfCIO-s7WkvGPx1XOAH

---

Built with ❤️ using React and TypeScript
