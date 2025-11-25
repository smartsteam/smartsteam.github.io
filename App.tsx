import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  LineChart, 
  Activity, 
  Zap, 
  Download, 
  Trash2, 
  Play, 
  Pause,
  Square, 
  Cpu,
  BrainCircuit,
  Settings,
  Image as ImageIcon,
  Maximize2,
  Globe,
  MessageSquare,
  Clock,
  Timer
} from 'lucide-react';
import { RealTimeChart } from './components/RealTimeChart';
import { DataLog } from './components/DataLog';
import { Button } from './components/Button';
import { DataPoint, ConnectionState, TimeMode } from './types';
import { analyzeExperimentData } from './services/geminiService';
import { translations, Language } from './translations';
import { formatElapsedTime } from './utils';

// Extend Navigator for Web Serial
declare global {
  interface Navigator {
    serial: any;
  }
}

// Standard Arduino/Serial Baud Rates
const BAUD_RATES = [
  300, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 
  74880, 115200, 230400, 250000, 500000, 1000000, 2000000
];

export default function App() {
  // --- State ---
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [port, setPort] = useState<any>(null);
  const [lang, setLang] = useState<Language>('ko'); // Default to Korean
  
  // Data State
  const [data, setData] = useState<DataPoint[]>([]);
  const [dataKeys, setDataKeys] = useState<string[]>([]);
  const [sensorNames, setSensorNames] = useState<Record<string, string>>({});
  const [startTime, setStartTime] = useState<number>(0);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  
  // Config State
  const [baudRate, setBaudRate] = useState<number>(115200);
  const [windowSize, setWindowSize] = useState<number>(100);
  const [isYAxisAuto, setIsYAxisAuto] = useState<boolean>(true);
  const [yAxisMin, setYAxisMin] = useState<number>(0);
  const [yAxisMax, setYAxisMax] = useState<number>(100);
  const [timeMode, setTimeMode] = useState<TimeMode>('relative');

  // AI State
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [userNote, setUserNote] = useState<string>('');

  // Refs for stream handling to avoid closure staleness
  const readerRef = useRef<any>(null);
  const readableStreamClosedRef = useRef<Promise<void> | null>(null);
  const inputBufferRef = useRef<string>('');
  const isPausedRef = useRef<boolean>(false); // Ref for immediate access in loop
  const startTimeRef = useRef<number>(0); // Ref for immediate access to start time

  // Sync ref with state
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  // Translation Helper
  const t = translations[lang];

  // --- Handlers ---

  const handleConnect = async () => {
    if (!navigator.serial) {
      alert("Web Serial API is not supported in this browser. Please use Chrome, Edge, or Opera.");
      return;
    }

    try {
      setConnectionState(ConnectionState.CONNECTING);
      const selectedPort = await navigator.serial.requestPort();
      await selectedPort.open({ baudRate });
      
      setPort(selectedPort);
      setConnectionState(ConnectionState.CONNECTED);
      
      const now = Date.now();
      setStartTime(now);
      startTimeRef.current = now; // Initialize ref immediately
      
      setIsPaused(false);
      
      // Start reading loop
      readSerialLoop(selectedPort);
    } catch (error) {
      console.error("Connection error:", error);
      setConnectionState(ConnectionState.ERROR);
      setTimeout(() => setConnectionState(ConnectionState.DISCONNECTED), 3000);
    }
  };

  const handleDisconnect = async () => {
    // 1. Cancel the reader to break the read loop
    if (readerRef.current) {
      try {
        await readerRef.current.cancel();
      } catch (e) {
        console.warn("Error cancelling reader:", e);
      }
    }

    // 2. Wait for the stream pipe to close
    if (readableStreamClosedRef.current) {
      try {
        await readableStreamClosedRef.current;
      } catch (e) {
        // Ignore error if stream was already closed or errored (expected during cancel)
        console.warn("Stream close error (expected):", e);
      }
      readableStreamClosedRef.current = null;
    }

    // 3. Close the port
    if (port) {
      try {
        await port.close();
      } catch (e) {
        console.error("Failed to close port:", e);
      }
    }
    
    setPort(null);
    setConnectionState(ConnectionState.DISCONNECTED);
    setIsPaused(false);
    readerRef.current = null;
  };

  const togglePause = () => {
    setIsPaused(prev => !prev);
  };

  const toggleLanguage = () => {
    setLang(prev => prev === 'ko' ? 'en' : 'ko');
  };

  const readSerialLoop = async (currentPort: any) => {
    const textDecoder = new TextDecoderStream();
    // Keep track of the stream closure promise
    readableStreamClosedRef.current = currentPort.readable.pipeTo(textDecoder.writable);
    
    const reader = textDecoder.readable.getReader();
    readerRef.current = reader;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          // Allow the serial port to be closed later.
          break;
        }
        if (value) {
          handleDataChunk(value);
        }
      }
    } catch (error) {
      console.error("Read error:", error);
    } finally {
      reader.releaseLock();
      readerRef.current = null;
    }
  };

  const handleDataChunk = (chunk: string) => {
    // Append to buffer regardless of pause state to maintain stream integrity
    inputBufferRef.current += chunk;
    
    // Process complete lines
    const lines = inputBufferRef.current.split('\n');
    
    // Keep the last partial line in the buffer
    inputBufferRef.current = lines.pop() || '';

    // If paused, we simply don't process the lines into state, essentially "ignoring" them for the chart
    if (isPausedRef.current) return;

    if (lines.length > 0) {
      const newDataPoints: DataPoint[] = [];
      let detectedKeys: string[] = [];

      lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        // Attempt to parse CSV
        const parts = trimmed.split(',').map(p => parseFloat(p.trim()));
        
        // Check if all parts are valid numbers
        if (parts.every(p => !isNaN(p))) {
          const now = Date.now();
          // Use ref for accurate start time reference inside closure
          const timeElapsed = (now - startTimeRef.current) / 1000;
          
          const point: DataPoint = {
            timestamp: timeElapsed,
            formattedTime: new Date().toLocaleTimeString('en-US', { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          };

          // Generate keys: Sensor 1, Sensor 2, etc.
          parts.forEach((val, idx) => {
            const key = `Sensor ${idx + 1}`;
            point[key] = val;
            if (!detectedKeys.includes(key)) detectedKeys.push(key);
          });

          newDataPoints.push(point);
        }
      });

      if (newDataPoints.length > 0) {
        setData(prev => {
          // Keep max 2000 points in memory to allow for larger window sizes
          const updated = [...prev, ...newDataPoints];
          return updated.slice(-2000); 
        });
        
        // Update keys if we found new dimensions
        setDataKeys(prev => {
          if (prev.length === 0 && detectedKeys.length > 0) {
             setSensorNames(curr => {
                const newNames = { ...curr };
                detectedKeys.forEach(k => {
                   if (!newNames[k]) newNames[k] = k;
                });
                return newNames;
             });
             return detectedKeys;
          }
          return prev;
        });
      }
    }
  };

  const handleClear = () => {
    setData([]);
    const now = Date.now();
    setStartTime(now);
    startTimeRef.current = now; // Reset ref as well
    setDataKeys([]);
    setSensorNames({});
    setAiAnalysis(null);
    setUserNote('');
  };

  const handleExport = () => {
    if (data.length === 0) return;
    
    const headers = ['Timestamp (s)', 'Time', ...dataKeys.map(k => sensorNames[k] || k)].join(',');
    const rows = data.map(pt => {
      const values = dataKeys.map(k => pt[k]);
      return `${pt.timestamp.toFixed(3)},${pt.formattedTime},${values.join(',')}`;
    }).join('\n');
    
    const csvContent = `data:text/csv;charset=utf-8,${headers}\n${rows}`;
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `experiment_data_${new Date().toISOString()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleAIAnalyze = async () => {
    setIsAnalyzing(true);
    // Don't clear previous analysis immediately to prevent flicker if user is just updating notes, 
    // but here we are generating new content so maybe clearing is better to show "loading"
    setAiAnalysis(null);
    
    const dataWithNames = data.map(pt => {
        const newPt: any = { timestamp: pt.timestamp };
        dataKeys.forEach(k => {
            newPt[sensorNames[k] || k] = pt[k];
        });
        return newPt as DataPoint;
    });

    const result = await analyzeExperimentData(dataWithNames, userNote, lang);
    
    setAiAnalysis(result);
    setIsAnalyzing(false);
  };

  const handleNameChange = (key: string, newName: string) => {
    setSensorNames(prev => ({
      ...prev,
      [key]: newName
    }));
  };

  const handleDownloadChart = () => {
    const chartNode = document.getElementById('chart-capture-zone');
    if (!chartNode) return;
    const svgElement = chartNode.querySelector('svg');
    if (!svgElement) return;

    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgElement);
    const canvas = document.createElement('canvas');
    const rect = svgElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Use white background for capture in light mode
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const img = new Image();
    const svgBlob = new Blob([svgString], {type: 'image/svg+xml;charset=utf-8'});
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const pngUrl = canvas.toDataURL('image/png');
      const downloadLink = document.createElement('a');
      downloadLink.href = pngUrl;
      downloadLink.download = `chart_snapshot_${new Date().getTime()}.png`;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
    };
    img.src = url;
  };

  // Clean up on unmount
  useEffect(() => {
    return () => {
      // Clean up connection on unmount if active
      if (connectionState === ConnectionState.CONNECTED) {
        // We can't await here in cleanup, but we can trigger the cleanup logic
        if (readerRef.current) readerRef.current.cancel().catch(console.error);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col h-screen max-h-screen bg-stone-50 text-stone-900 overflow-hidden">
      
      {/* Header */}
      <header className="h-16 border-b border-stone-200 bg-white/80 backdrop-blur flex items-center justify-between px-6 shrink-0 z-20">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-lg shadow-sm">
            <Activity className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-xl tracking-tight text-stone-900">{t.appTitle}</h1>
            <p className="text-xs text-stone-500">{t.appSubtitle}</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          
          {/* Language Toggle */}
          <button 
            onClick={toggleLanguage}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-stone-50 border border-stone-200 text-xs text-stone-600 font-medium transition-colors shadow-sm"
          >
            <Globe className="w-3 h-3" />
            {lang === 'ko' ? 'English' : '한국어'}
          </button>

          <div className="w-px h-6 bg-stone-300 mx-2"></div>

          {/* Time Mode Select */}
           <div className="flex items-center gap-2 bg-white p-1 rounded-lg border border-stone-200 shadow-sm">
            {timeMode === 'relative' ? <Timer className="w-4 h-4 ml-2 text-stone-500" /> : <Clock className="w-4 h-4 ml-2 text-stone-500" />}
            <select 
              className="bg-transparent text-sm text-stone-700 focus:outline-none p-1 cursor-pointer"
              value={timeMode}
              onChange={(e) => setTimeMode(e.target.value as TimeMode)}
            >
              <option value="relative" className="bg-white">{t.relativeTime}</option>
              <option value="absolute" className="bg-white">{t.absoluteTime}</option>
            </select>
          </div>

          <div className="flex items-center gap-2 bg-white p-1 rounded-lg border border-stone-200 shadow-sm">
            <Settings className="w-4 h-4 ml-2 text-stone-500" />
            <select 
              className="bg-transparent text-sm text-stone-700 focus:outline-none p-1 cursor-pointer"
              value={baudRate}
              onChange={(e) => setBaudRate(Number(e.target.value))}
              disabled={connectionState === ConnectionState.CONNECTED}
            >
              {BAUD_RATES.map((rate) => (
                <option key={rate} value={rate} className="bg-white text-stone-900">
                  {rate} Baud
                </option>
              ))}
            </select>
          </div>

          {connectionState === ConnectionState.DISCONNECTED || connectionState === ConnectionState.ERROR ? (
            <Button onClick={handleConnect} icon={<Zap className="w-4 h-4" />}>
              {t.connect}
            </Button>
          ) : (
            <div className="flex items-center gap-2">
               <Button 
                variant={isPaused ? "primary" : "secondary"} 
                onClick={togglePause} 
                icon={isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                className="w-32"
              >
                {isPaused ? t.resume : t.pause}
              </Button>
              <Button variant="danger" onClick={handleDisconnect} icon={<Square className="w-4 h-4" />}>
                {t.stop}
              </Button>
            </div>
          )}
        </div>
      </header>

      {/* Main Content Grid */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 p-6 overflow-hidden">
        
        {/* Left Column: Visualizations (8 cols) */}
        <div className="lg:col-span-8 flex flex-col gap-6 h-full overflow-hidden">
          
          {/* Chart Section (2/3 height) */}
          <div className="flex-[2] bg-white rounded-xl border border-stone-200 p-4 shadow-sm flex flex-col min-h-0 relative">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 shrink-0 gap-4">
              <div className="flex items-center gap-4">
                  <h2 className="text-lg font-semibold flex items-center gap-2 text-stone-800">
                    <Activity className="w-5 h-5 text-blue-600" />
                    {t.liveData}
                  </h2>
                  {connectionState === ConnectionState.CONNECTED && !isPaused && (
                    <span className="flex items-center gap-1 text-xs text-green-600 animate-pulse">
                      <span className="w-2 h-2 rounded-full bg-green-500"></span>
                      {t.active}
                    </span>
                  )}
                  {connectionState === ConnectionState.CONNECTED && isPaused && (
                    <span className="flex items-center gap-1 text-xs text-amber-500">
                      <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                      {t.paused}
                    </span>
                  )}
              </div>

              {/* Chart Controls */}
              <div className="flex flex-wrap items-center gap-3 bg-stone-100 p-2 rounded-lg border border-stone-200">
                  {/* Window Size Control */}
                  <div className="flex items-center gap-2 px-2 border-r border-stone-300">
                    <span className="text-xs text-stone-500 font-medium">{t.xAxis}</span>
                    <input 
                      type="range" 
                      min="10" 
                      max="500" 
                      step="10"
                      value={windowSize}
                      onChange={(e) => setWindowSize(Number(e.target.value))}
                      className="w-24 h-1 bg-stone-300 rounded-lg appearance-none cursor-pointer"
                    />
                    <span className="text-xs text-stone-600 w-8 text-right">{windowSize}</span>
                  </div>

                  {/* Y-Axis Control */}
                  <div className="flex items-center gap-2">
                     <span className="text-xs text-stone-500 font-medium">{t.yAxis}</span>
                     <label className="flex items-center gap-1 text-xs text-stone-600 cursor-pointer mr-2">
                        <input 
                          type="checkbox" 
                          checked={isYAxisAuto}
                          onChange={(e) => setIsYAxisAuto(e.target.checked)}
                          className="rounded border-stone-300 bg-white text-blue-600 focus:ring-offset-white"
                        />
                        {t.auto}
                     </label>
                     {!isYAxisAuto && (
                        <div className="flex items-center gap-1">
                           <input 
                              type="number" 
                              value={yAxisMin}
                              onChange={(e) => setYAxisMin(Number(e.target.value))}
                              className="w-14 bg-white border border-stone-300 rounded px-1 text-xs text-right text-stone-800"
                              placeholder="Min"
                           />
                           <span className="text-stone-400">-</span>
                           <input 
                              type="number" 
                              value={yAxisMax}
                              onChange={(e) => setYAxisMax(Number(e.target.value))}
                              className="w-14 bg-white border border-stone-300 rounded px-1 text-xs text-right text-stone-800"
                              placeholder="Max"
                           />
                        </div>
                     )}
                  </div>
              </div>

              <button 
                onClick={handleDownloadChart}
                className="p-2 bg-stone-100 hover:bg-stone-200 rounded text-stone-600 transition-colors flex items-center gap-1 text-xs"
                title={t.downloadChart}
              >
                <ImageIcon className="w-4 h-4" />
              </button>
            </div>
            
            <div className="flex-1 w-full min-h-0" id="chart-capture-zone">
              <RealTimeChart 
                data={data} 
                dataKeys={dataKeys} 
                sensorNames={sensorNames}
                windowSize={windowSize}
                yAxisDomain={isYAxisAuto ? ['auto', 'auto'] : [yAxisMin, yAxisMax]}
                emptyMessage={t.waiting}
                xAxisKey={timeMode === 'relative' ? 'timestamp' : 'formattedTime'}
              />
            </div>
          </div>

          {/* AI Analysis Section (1/3 height, split vertically) */}
          <div className="flex-1 min-h-[250px] bg-white rounded-xl border border-stone-200 p-4 shadow-sm flex flex-col shrink-0">
             <div className="flex justify-between items-center mb-3">
                <h2 className="text-lg font-semibold flex items-center gap-2 bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
                  <BrainCircuit className="w-5 h-5 text-purple-600" />
                  {t.aiInsight}
                </h2>
                <Button 
                  variant="secondary" 
                  size="sm" 
                  className="text-xs py-1 h-8 bg-stone-100 hover:bg-stone-200 text-stone-700 border border-stone-200" 
                  onClick={handleAIAnalyze}
                  disabled={data.length < 5 || isAnalyzing}
                >
                  <MessageSquare className="w-3 h-3" />
                  {isAnalyzing ? t.analyzing : t.analyze}
                </Button>
             </div>
             
             {/* Split View: User Input (Left) - AI Output (Right) */}
             <div className="flex-1 flex flex-col md:flex-row gap-4 min-h-0">
                
                {/* User Input Area */}
                <div className="flex-1 flex flex-col gap-2">
                   <label className="text-xs font-semibold text-stone-500 uppercase tracking-wider ml-1">
                      {t.userObservation}
                   </label>
                   <textarea 
                      value={userNote}
                      onChange={(e) => setUserNote(e.target.value)}
                      placeholder={t.userPlaceholder}
                      className="flex-1 w-full bg-stone-50 border border-stone-200 rounded-lg p-3 text-sm text-stone-800 resize-none focus:outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-400 transition-all placeholder:text-stone-400"
                   />
                </div>

                {/* Vertical Divider (Visible on desktop) */}
                <div className="hidden md:block w-px bg-stone-200 my-2"></div>

                {/* AI Output Area */}
                <div className="flex-1 flex flex-col gap-2 min-w-0">
                   <label className="text-xs font-semibold text-stone-500 uppercase tracking-wider ml-1">
                      {t.feedbackTitle}
                   </label>
                   <div className="flex-1 bg-stone-50 rounded-lg p-3 overflow-y-auto custom-scrollbar border border-stone-200">
                      {isAnalyzing ? (
                        <div className="flex flex-col items-center justify-center h-full text-stone-500 gap-2">
                          <div className="w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                          <p className="text-sm">{t.analyzingDesc}</p>
                        </div>
                      ) : aiAnalysis ? (
                        <div className="prose prose-sm max-w-none whitespace-pre-wrap text-stone-700 text-sm leading-relaxed">
                          {aiAnalysis}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full text-stone-400 italic text-sm text-center px-4">
                          <p>{t.noDataAnalysis}</p>
                        </div>
                      )}
                   </div>
                </div>

             </div>
          </div>
        </div>

        {/* Right Column: Data Log & Controls (4 cols) */}
        <div className="lg:col-span-4 flex flex-col gap-6 h-full overflow-hidden">
          
          {/* Stats Cards */}
          <div className="grid grid-cols-2 gap-4 shrink-0">
            <div className="bg-white p-4 rounded-xl border border-stone-200 shadow-sm">
              <p className="text-stone-500 text-xs uppercase font-bold">{t.dataPoints}</p>
              <p className="text-2xl font-mono font-bold text-stone-900 mt-1">{data.length}</p>
            </div>
            <div className="bg-white p-4 rounded-xl border border-stone-200 shadow-sm">
              <p className="text-stone-500 text-xs uppercase font-bold">{t.duration}</p>
              <p className="text-2xl font-mono font-bold text-stone-900 mt-1">
                {data.length > 0 ? formatElapsedTime(data[data.length - 1].timestamp) : "00:00:00.000"}
              </p>
            </div>
          </div>

          {/* Data Table */}
          <div className="flex-1 min-h-0 flex flex-col bg-white rounded-xl border border-stone-200 p-4 shadow-sm">
            <div className="flex justify-between items-center mb-4 shrink-0">
              <h2 className="text-lg font-semibold flex items-center gap-2 text-stone-800">
                <Cpu className="w-5 h-5 text-emerald-600" />
                {t.dataLog}
              </h2>
              <div className="flex gap-2">
                <button 
                  onClick={handleExport} 
                  disabled={data.length === 0}
                  className="p-2 hover:bg-stone-100 rounded-lg text-stone-500 hover:text-stone-900 transition-colors disabled:opacity-30"
                  title={t.export}
                >
                  <Download className="w-4 h-4" />
                </button>
                <button 
                  onClick={handleClear} 
                  className="p-2 hover:bg-red-50 rounded-lg text-stone-500 hover:text-red-500 transition-colors"
                  title={t.clear}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 relative">
               <DataLog 
                  data={data} 
                  dataKeys={dataKeys} 
                  sensorNames={sensorNames}
                  onNameChange={handleNameChange}
                  translations={{ time: t.time, value: t.value, noData: t.noData }}
                  timeMode={timeMode}
               />
            </div>
          </div>
          
          {/* Instructions (Bottom Right) */}
          <div className="bg-stone-100 border border-stone-200 p-4 rounded-xl text-xs text-stone-600 shrink-0">
            <p className="font-semibold text-stone-800 mb-1">{t.instructionsTitle}</p>
            <ol className="list-decimal pl-4 space-y-1">
              {t.instructions.map((inst, i) => (
                <li key={i}>
                  {inst.includes('\\n') ? (
                    <>
                      {inst.split('\\n')[0]}
                      <code className="bg-stone-200 px-1 rounded text-stone-800 font-mono">\n</code>
                      {inst.split('\\n')[1]}
                    </>
                  ) : inst}
                </li>
              ))}
            </ol>
          </div>
        </div>

      </main>
    </div>
  );
}