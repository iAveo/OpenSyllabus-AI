/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Settings, Search, Loader2, Play, BookOpen, ChevronRight, X, AlertCircle, Youtube, Download, Trash2, Zap, History, Globe, FileText, Link as LinkIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type } from '@google/genai';

// Initialize the API using the platform-provided key
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface Resource {
  title: string;
  url: string;
  type: string;
  description?: string;
}

interface ModuleData {
  title: string;
  description: string;
  resources: Resource[];
}

interface HistoryItem {
  id: string;
  url: string;
  timestamp: number;
  syllabus: ModuleData[];
  rawModules: ModuleData[];
}

type AppStatus = 'idle' | 'fetching_course' | 'extracting_syllabus' | 'delegating_agents' | 'verifying_results' | 'success' | 'error';

// --- Multi-Agent Workflow Core ---

// Agent 1: Syllabus Extractor (used directly in handleGenerate)

// Agent 2: YouTube Searcher
async function runYoutubeAgent(modules: {title: string, description: string}[], ytKey?: string): Promise<Resource[][]> {
  const results: Resource[][] = [];
  for (const mod of modules) {
    let modResources: Resource[] = [];
    if (ytKey) {
      try {
        const query = `${mod.title} ${mod.description.substring(0, 50)}`;
        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(query)}&key=${ytKey}&maxResults=2`);
        if (res.ok) {
          const data = await res.json();
          modResources = (data.items || []).map((item: any) => ({
            title: item.snippet.title,
            url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
            type: 'YouTube Video',
            description: item.snippet.description ? item.snippet.description.substring(0, 150) + '...' : undefined
          }));
        }
      } catch (err) { console.error("YT API Error", err); }
    }
    results.push(modResources);
  }
  return results;
}

// Agent 3: Google Books Searcher
async function runGoogleBooksAgent(modules: {title: string, description: string}[], gbKey?: string): Promise<Resource[][]> {
  const results: Resource[][] = [];
  for (const mod of modules) {
    let modResources: Resource[] = [];
    if (gbKey) {
      try {
        const query = `${mod.title} textbook`;
        const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&key=${gbKey}&maxResults=2`);
        if (res.ok) {
          const data = await res.json();
          modResources = (data.items || []).map((item: any) => ({
            title: item.volumeInfo.title,
            url: item.volumeInfo.previewLink || item.volumeInfo.infoLink,
            type: 'Book Chapter',
            description: item.volumeInfo.description ? item.volumeInfo.description.substring(0, 150) + '...' : undefined
          }));
        }
      } catch (err) { console.error("GB API Error", err); }
    }
    results.push(modResources);
  }
  return results;
}

// Agent 4: LLM-Driven Web & Document Discovery Agent
async function runDiscoveryAgent(
  modules: {title: string, description: string}[],
  prefs: { articles: boolean, documents: boolean }
): Promise<Resource[][]> {
  // If neither is enabled, we don't need to run it
  if (!prefs.articles && !prefs.documents) {
    return modules.map(() => []);
  }

  const promises = modules.map(async (mod) => {
    
    let categoriesDesc = "";
    if (prefs.articles) {
      categoriesDesc += `\n**CATEGORY 1 — Web Articles & Tutorials:**\nSearch for high-quality articles, tutorials, and Khan Academy links related to this topic. Do NOT include videos or books. Prioritize authoritative educational sources.\n`;
    }
    if (prefs.documents) {
      categoriesDesc += `\n**CATEGORY 2 — Documents & Slides:**\nSearch using filetype:pdf and filetype:ppt queries to find direct academic papers, university lecture slides, and PowerPoint downloads related to this topic.\n`;
    }

    const properties: any = {};
    const requiredFields = [];
    
    if (prefs.articles) {
      properties.articles = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            url: { type: Type.STRING },
            source: { type: Type.STRING },
            description: { type: Type.STRING }
          },
          required: ["title", "url", "source", "description"]
        }
      };
      requiredFields.push("articles");
    }

    if (prefs.documents) {
      properties.documents = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            url: { type: Type.STRING },
            fileType: { type: Type.STRING, description: "e.g., pdf, ppt" },
            source: { type: Type.STRING },
            description: { type: Type.STRING }
          },
          required: ["title", "url", "fileType", "source", "description"]
        }
      };
      requiredFields.push("documents");
    }

    const prompt = `You are a resource discovery agent. For the course module titled "${mod.title}" 
(${mod.description}), use Google Search to find resources for the requested categories.
${categoriesDesc}
Return your results as a JSON object strictly matching the schema.

Rules:
- Return at least 2 results per category, no more than 4 each.
- Only include URLs you have actually retrieved via search — no guessed or constructed links.
- If no resources are found for a category, return an empty array for it.`;

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: prompt,
        tools: [{ googleSearch: {} }],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties,
            required: requiredFields
          }
        }
      });
      
      const data = JSON.parse(response.text?.trim() || '{}');
      
      const modResources: Resource[] = [];
      if (data.articles) {
        data.articles.forEach((a: any) => modResources.push({
          title: a.title,
          url: a.url,
          type: 'Web Article',
          description: a.description
        }));
      }
      if (data.documents) {
        data.documents.forEach((d: any) => modResources.push({
          title: d.title,
          url: d.url,
          type: d.fileType ? `${d.fileType.toUpperCase()} Document` : 'Document',
          description: d.description
        }));
      }
      return modResources;
    } catch (err) {
      console.error("Discovery Agent Failed for module:", mod.title, err);
      return [];
    }
  });

  return await Promise.all(promises);
}

// Agent 5: The Reviewer / Checker Agent (LLM driven)
async function runCheckerAgent(modules: {title: string, description: string}[], combinedResources: Resource[][]): Promise<ModuleData[]> {
  const verificationPayload = modules.map((mod, i) => ({
    title: mod.title,
    description: mod.description,
    candidate_resources: combinedResources[i] || []
  }));

  const prompt = `You are the Evaluator Agent.
I will give you a list of course modules, each with 'candidate_resources' supplied by sub-agents (YouTube, Books, Web, Documents).
Your job is to review the candidate URLs. Filter out duplicates or entirely irrelevant entries, ensure there is a good mix of videos, readings, and downloadable presentations (PDF/PPT) if possible, and output the finalized syllabus.

Payload:
${JSON.stringify(verificationPayload, null, 2)}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              description: { type: Type.STRING },
              resources: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    url: { type: Type.STRING },
                    type: { type: Type.STRING },
                    description: { type: Type.STRING }
                  },
                  required: ["title", "url", "type"]
                }
              }
            },
            required: ["title", "description", "resources"]
          }
        }
      }
    });
    return JSON.parse(response.text?.trim() || "[]");
  } catch (err) {
    console.error("Checker Agent failed", err);
    // fallback if evaluator crashes: just zip them together
    return modules.map((mod, i) => ({
      ...mod,
      resources: combinedResources[i] || []
    }));
  }
}

export default function App() {
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<AppStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [syllabus, setSyllabus] = useState<ModuleData[]>([]);
  const [rawModules, setRawModules] = useState<ModuleData[]>([]);

  const [youtubeKey, setYoutubeKey] = useState('');
  const [googleBooksKey, setGoogleBooksKey] = useState('');
  
  // Pre-search Preferences
  const [searchPreferences, setSearchPreferences] = useState({
    videos: true,
    books: true,
    articles: true,
    documents: true
  });

  type FilterType = 'all' | 'video' | 'article' | 'document' | 'book';
  const [resourceFilter, setResourceFilter] = useState<FilterType>('all');

  useEffect(() => {
    // Restore saved API keys
    const savedYtKey = localStorage.getItem('os_youtube_key');
    if (savedYtKey) setYoutubeKey(savedYtKey);
    const savedGbKey = localStorage.getItem('os_google_books_key');
    if (savedGbKey) setGoogleBooksKey(savedGbKey);

    // Restore saved syllabus state
    const savedState = localStorage.getItem('os_saved_syllabus');
    if (savedState) {
      try {
        const { savedUrl, savedSyllabus, savedRaw } = JSON.parse(savedState);
        if (savedSyllabus && savedSyllabus.length > 0) {
          setUrl(savedUrl || '');
          setSyllabus(savedSyllabus);
          setRawModules(savedRaw || []);
          setStatus('success');
        }
      } catch (e) {
        console.error("Failed to restore syllabus from local storage", e);
      }
    }

    // Restore history
    const savedHistory = localStorage.getItem('os_history');
    if (savedHistory) {
      try {
        setHistory(JSON.parse(savedHistory));
      } catch (e) {
        console.error("Failed to restore history", e);
      }
    }
  }, []);

  // Save syllabus to local storage whenever it updates successfully
  useEffect(() => {
    if (status === 'success' && syllabus.length > 0) {
      localStorage.setItem('os_saved_syllabus', JSON.stringify({
        savedUrl: url,
        savedSyllabus: syllabus,
        savedRaw: rawModules
      }));
      
      setHistory(prev => {
        const filtered = prev.filter(item => item.url !== url);
        const newItem: HistoryItem = {
          id: Date.now().toString(),
          url,
          timestamp: Date.now(),
          syllabus,
          rawModules
        };
        const nextHistory = [newItem, ...filtered].slice(0, 15);
        localStorage.setItem('os_history', JSON.stringify(nextHistory));
        return nextHistory;
      });
    }
  }, [status, syllabus, url, rawModules]);

  const clearSyllabus = () => {
    setSyllabus([]);
    setRawModules([]);
    setStatus('idle');
    setUrl('');
    localStorage.removeItem('os_saved_syllabus');
  };

  const exportToMarkdown = () => {
    let md = `# Generated Syllabus\n\n**Source:** ${url || "Custom Link"}\n\n`;
    
    syllabus.forEach((mod, idx) => {
      md += `## Module ${idx + 1}: ${mod.title}\n\n`;
      md += `${mod.description}\n\n`;
      if (mod.resources && mod.resources.length > 0) {
        md += `**Recommended Resources:**\n`;
        mod.resources.forEach(res => {
          md += `- [${res.title}](${res.url}) (${res.type})\n`;
        });
        md += `\n`;
      }
      md += `---\n\n`;
    });
    
    const blob = new Blob([md], { type: 'text/markdown' });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = 'OpenSyllabus_Export.md';
    a.click();
    URL.revokeObjectURL(objectUrl);
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    
    try {
      setStatus('fetching_course');
      setErrorMsg('');
      setSyllabus([]);
       
      let htmlString = "";
      try {
        const proxyUrl1 = `https://api.allorigins.win/get?url=${encodeURIComponent(url.trim())}`;
        const res1 = await fetch(proxyUrl1);
        if (!res1.ok) throw new Error("AllOrigins proxy returned non-ok status");
        const data = await res1.json();
        htmlString = data.contents;
      } catch (err1) {
        console.warn("Primary proxy failed, trying fallback...", err1);
        try {
          const proxyUrl2 = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url.trim())}`;
          const res2 = await fetch(proxyUrl2);
          if (!res2.ok) throw new Error("CodeTabs proxy returned non-ok status");
          htmlString = await res2.text();
        } catch (err2) {
          console.warn("Fallback proxy failed, trying last resort...", err2);
          const proxyUrl3 = `https://corsProxy.io/?${encodeURIComponent(url.trim())}`;
          const res3 = await fetch(proxyUrl3);
          if (!res3.ok) throw new Error("All CORS proxies failed to fetch the URL.");
          htmlString = await res3.text();
        }
      }
      
      if (!htmlString) throw new Error("No content received from the URL. Check the link.");
       
      const doc = new DOMParser().parseFromString(htmlString, "text/html");
      doc.querySelectorAll('script, style, nav, footer, header').forEach(el => el.remove());
      
      let text = doc.body.innerText.replace(/\s+/g, ' ').trim();
      // Cap at 40000 chars for prompt safety
      if (text.length > 40000) text = text.slice(0, 40000);
      
      if (text.length < 100) {
        throw new Error("Could not extract enough readable text from that course page.");
      }

      setStatus('extracting_syllabus');
       
      const outlineResponse = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: `Analyze this course page text. Extract the main modules/weeks of the curriculum. For each module, output its title and a very brief description of the core topics.\n\nCourse Text:\n${text}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                description: { type: Type.STRING }
              },
              required: ["title", "description"]
            }
          }
        }
      });
       
      let outline: {title: string, description: string}[] = [];
      if (!outlineResponse.text) throw new Error("No response received from AI syllabus extraction.");
      try { outline = JSON.parse(outlineResponse.text.trim()); } 
      catch (e) { throw new Error("Failed to parse the structured syllabus outline."); }
      if (outline.length === 0) throw new Error("AI could not find a distinct syllabus in this page.");

      // STEP 2: Multi-Agent Dispatch
      setStatus('delegating_agents');
      const [youtubeResults, booksResults, discoveryResults] = await Promise.all([
        searchPreferences.videos ? runYoutubeAgent(outline, youtubeKey) : Promise.resolve(outline.map(() => [])),
        searchPreferences.books ? runGoogleBooksAgent(outline, googleBooksKey) : Promise.resolve(outline.map(() => [])),
        (searchPreferences.articles || searchPreferences.documents) 
          ? runDiscoveryAgent(outline, { articles: searchPreferences.articles, documents: searchPreferences.documents })
          : Promise.resolve(outline.map(() => []))
      ]);

      // Combine step
      const combinedResources = outline.map((_, i) => {
        return [...(youtubeResults[i] || []), ...(booksResults[i] || []), ...(discoveryResults[i] || [])];
      });

      // STEP 3: Checker / Evaluator Agent
      setStatus('verifying_results');
      const finalizedSyllabus = await runCheckerAgent(outline, combinedResources);

      setRawModules(finalizedSyllabus);
      setSyllabus(finalizedSyllabus);
      setStatus('success');
       
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "An unexpected error occurred during processing.");
      setStatus('error');
    }
  };

  const statusMessages: Record<string, string> = {
    fetching_course: "Fetching course curriculum...",
    extracting_syllabus: "Agent 1: Extracting syllabus outline...",
    delegating_agents: "Agents 2-4: Searching YouTube, Google Books, articles and documents...",
    verifying_results: "Agent 5: Verifying and finalizing top resources...",
    analyzing: "Processing...",
  };

  return (
    <div className="min-h-screen bg-[#030712] text-slate-300 font-sans flex flex-col overflow-hidden relative selection:bg-indigo-500/30">
      {/* Background Volumetric Glows */}
      <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-indigo-500/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/10 rounded-full blur-[120px]" />
      </div>

      {/* Main Content Space */}
      <div className="relative z-10 flex flex-col h-full flex-1">
        
        {/* Header Navigation */}
        <header className="h-16 border-b border-white/[0.08] flex items-center justify-between px-6 lg:px-8 bg-black/20 backdrop-blur-xl shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 flex items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 shadow-lg shadow-blue-500/20">
              <BookOpen className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold tracking-tight text-white text-xl hidden sm:block">OpenSyllabus</span>
            <span className="text-[10px] font-bold tracking-widest text-indigo-400 uppercase bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded-full ml-1">Pro</span>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsHistoryOpen(true)}
              className="flex items-center gap-2 text-sm font-medium hover:bg-white/10 px-4 py-2 rounded-full transition-colors text-slate-400 hover:text-white"
            >
              <History className="w-4 h-4" />
              <span className="hidden sm:inline">History</span>
            </button>
            <button 
              onClick={() => setIsSettingsOpen(true)}
              className="flex items-center gap-2 text-sm font-medium bg-white/5 hover:bg-white/10 border border-white/10 px-4 py-2 rounded-full shadow-sm transition-colors text-slate-300 hover:text-white"
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">API Keys</span>
            </button>
          </div>
        </header>

        {/* Main Search Area */}
        <section className={`px-6 lg:px-8 flex-shrink-0 transition-all duration-500 ${status === 'idle' && syllabus.length === 0 ? 'py-32' : 'py-8 border-b border-white/5 bg-white/[0.01]'}`}>
          <div className="max-w-4xl mx-auto flex flex-col gap-6">
            
            {status === 'idle' && syllabus.length === 0 && (
              <div className="text-center space-y-4 mb-4">
                <h1 className="text-4xl sm:text-5xl lg:text-6xl font-medium tracking-tight bg-gradient-to-br from-white to-neutral-500 bg-clip-text text-transparent pb-2">
                  Recreate any course for free.
                </h1>
                <p className="text-lg text-slate-400 font-light max-w-2xl mx-auto">
                  Paste a link to any premium Coursera or university program. Gemini will extract the exact syllabus and source equivalent videos, articles, and book chapters.
                </p>
              </div>
            )}

            <form onSubmit={handleGenerate} className="flex flex-col gap-4 relative w-full group">
              <div className="flex gap-3 w-full">
                <div className="flex-1 relative">
                  <Search className={`w-5 h-5 absolute left-5 top-1/2 -translate-y-1/2 transition-colors ${status === 'idle' ? 'text-slate-500 group-focus-within:text-indigo-400' : 'text-slate-600'}`} />
                  <input 
                    type="url" 
                    required
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    placeholder="Paste Coursera URL (e.g., coursera.org/learn/...)"
                    disabled={status !== 'idle' && status !== 'success' && status !== 'error'}
                    className={`w-full bg-white/[0.03] border border-white/[0.08] hover:border-white/20 focus:border-indigo-500/50 rounded-2xl py-4 pl-14 pr-4 focus:outline-none focus:ring-4 focus:ring-indigo-500/10 placeholder:text-slate-500 disabled:opacity-50 text-white backdrop-blur-md transition-all shadow-xl ${status === 'idle' ? 'text-lg' : 'text-base'}`}
                  />
                </div>
                <button 
                  type="submit"
                  disabled={status !== 'idle' && status !== 'success' && status !== 'error'}
                  className="bg-white hover:bg-slate-200 text-black font-medium py-4 px-8 rounded-2xl transition-all shadow-lg shadow-white/10 disabled:opacity-50 disabled:cursor-not-allowed hidden sm:block delay-75"
                >
                  Generate
                </button>
              </div>

              {/* Pre-Search Preferences */}
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-widest pl-2">Resource Types:</span>
                {[
                  { id: 'videos', label: 'Videos', icon: Play },
                  { id: 'articles', label: 'Articles', icon: Globe },
                  { id: 'documents', label: 'PDFs & PPTs', icon: FileText },
                  { id: 'books', label: 'Books', icon: BookOpen }
                ].map(pref => {
                  const Icon = pref.icon;
                  const isActive = searchPreferences[pref.id as keyof typeof searchPreferences];
                  return (
                    <button
                      key={pref.id}
                      type="button"
                      disabled={status !== 'idle' && status !== 'success' && status !== 'error'}
                      onClick={() => setSearchPreferences(p => ({...p, [pref.id]: !isActive}))}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-all ${
                        isActive 
                          ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-300 shadow-sm shadow-indigo-500/10' 
                          : 'border-white/10 bg-white/5 text-slate-500 hover:text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {pref.label}
                    </button>
                  );
                })}
              </div>

              <AnimatePresence>
                {errorMsg && (
                  <motion.div 
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="absolute top-full mt-3 left-0 right-0 z-10 flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 shadow-xl backdrop-blur-xl"
                  >
                    <AlertCircle className="w-5 h-5 shrink-0" />
                    <p className="text-sm">{errorMsg}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </form>

            {/* Quick Examples - Only show prominently when idle */}
            <AnimatePresence>
              {(status === 'idle' && syllabus.length === 0) && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-wrap items-center justify-center gap-3 mt-4"
                >
                  <span className="text-sm text-slate-500 font-medium">Try an example:</span>
                  <button 
                    type="button" 
                    onClick={() => setUrl("https://www.coursera.org/learn/machine-learning")} 
                    className="flex items-center gap-2 text-sm bg-white/[0.03] border border-white/10 hover:bg-white/[0.08] hover:border-indigo-500/30 px-4 py-2 rounded-full transition-all text-slate-300 hover:text-white"
                  >
                    <Zap className="w-4 h-4 text-yellow-500" />
                    Machine Learning
                  </button>
                  <button 
                    type="button" 
                    onClick={() => setUrl("https://www.coursera.org/learn/the-science-of-well-being")} 
                    className="flex items-center gap-2 text-sm bg-white/[0.03] border border-white/10 hover:bg-white/[0.08] hover:border-indigo-500/30 px-4 py-2 rounded-full transition-all text-slate-300 hover:text-white"
                  >
                    <Zap className="w-4 h-4 text-emerald-400" />
                    Science of Well-Being
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>

        <main className="flex flex-1 overflow-hidden max-w-[1600px] mx-auto w-full">
          {/* Sidebar Status / Loader */}
          <aside className="hidden md:flex w-72 border-r border-white/5 p-8 flex-col gap-8 shrink-0 bg-white/[0.01]">
            <div className="space-y-6">
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Multi-Agent Pipeline</h3>
              <div className="flex flex-col gap-6">
                
                <div className={`flex items-center gap-4 transition-opacity duration-300 ${(status === 'extracting_syllabus' || status === 'delegating_agents' || status === 'verifying_results' || status === 'success') ? "opacity-100" : "opacity-30"}`}>
                  <div className="w-6 h-6 rounded-full border border-emerald-500/30 bg-emerald-500/10 flex items-center justify-center shrink-0">
                    {(status !== 'extracting_syllabus') ? (
                      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="w-2.5 h-2.5 bg-emerald-400 rounded-full shadow-[0_0_10px_rgba(52,211,153,0.8)]" />
                    ) : (
                       <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
                    )}
                  </div>
                  <span className="text-sm font-medium text-slate-200">1. Syllabus Extractor</span>
                </div>

                <div className={`flex items-center gap-4 transition-opacity duration-300 ${(status === 'delegating_agents' || status === 'verifying_results' || status === 'success') ? "opacity-100" : "opacity-30"}`}>
                  <div className="w-6 h-6 rounded-full border border-blue-500/30 bg-blue-500/10 flex items-center justify-center shrink-0">
                    {(status === 'verifying_results' || status === 'success') ? (
                      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="w-2.5 h-2.5 bg-blue-400 rounded-full shadow-[0_0_10px_rgba(96,165,250,0.8)]" />
                    ) : status === 'delegating_agents' ? (
                       <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
                    ) : <div className="w-1.5 h-1.5 bg-blue-500/50 rounded-full" />}
                  </div>
                  <span className="text-sm font-medium text-slate-200">2. Sub-Agents Searching</span>
                </div>

                <div className={`flex items-center gap-4 transition-opacity duration-300 ${(status === 'verifying_results' || status === 'success') ? "opacity-100" : "opacity-30"}`}>
                  <div className="w-6 h-6 rounded-full border border-indigo-500/30 bg-indigo-500/10 flex items-center justify-center shrink-0">
                    {(status === 'success') ? (
                      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="w-2.5 h-2.5 bg-indigo-400 rounded-full shadow-[0_0_10px_rgba(99,102,241,0.8)]" />
                    ) : status === 'verifying_results' ? (
                       <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                    ) : <div className="w-1.5 h-1.5 bg-indigo-500/50 rounded-full" />}
                  </div>
                  <span className="text-sm font-medium text-slate-200">3. Evaluator Checker</span>
                </div>

              </div>
            </div>

            <div className="mt-auto">
              <div className="p-5 rounded-2xl bg-gradient-to-br from-indigo-500/10 to-blue-500/10 border border-indigo-500/20 backdrop-blur-md">
                <p className="text-xs leading-relaxed text-indigo-200">
                  <span className="font-semibold text-indigo-100 block mb-1">How it works:</span>
                  The main Agent extracts structure. It delegates work to YouTube, Books, Web, and Document agents running in parallel. Finally, a Checker Agent validates all sources together.
                </p>
              </div>
            </div>
          </aside>

          {/* Results Grid Area */}
          <section className="flex-1 p-6 lg:p-8 overflow-y-auto">
            {status === 'idle' && syllabus.length === 0 && (
               <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-6 opacity-60">
                 <div className="w-24 h-24 rounded-full border-2 border-dashed border-white/20 flex items-center justify-center bg-white/5">
                   <BookOpen className="w-10 h-10 text-slate-400" />
                 </div>
                 <p className="text-lg">Awaiting course extraction...</p>
               </div>
            )}

            {(status === 'fetching_course' || status === 'analyzing' || status === 'extracting_syllabus' || status === 'delegating_agents' || status === 'verifying_results') && (
              <div className="h-full flex flex-col items-center justify-center space-y-8">
                <div className="relative">
                  <div className="absolute inset-0 bg-indigo-500/30 blur-2xl rounded-full" />
                  <Loader2 className="w-12 h-12 text-indigo-400 animate-spin relative z-10" />
                </div>
                <p className="text-lg text-slate-300 font-medium tracking-wide">{statusMessages[status]}</p>
                <div className="flex flex-col items-center gap-2 mt-4 opacity-50">
                   <div className="flex gap-2">
                     <div className={`w-2 h-2 rounded-full ${status === 'extracting_syllabus' ? 'bg-indigo-400 animate-pulse' : 'bg-slate-600'}`} />
                     <div className={`w-2 h-2 rounded-full ${status === 'delegating_agents' ? 'bg-blue-400 animate-pulse' : 'bg-slate-600'}`} />
                     <div className={`w-2 h-2 rounded-full ${status === 'verifying_results' ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
                   </div>
                </div>
              </div>
            )}
            
            {status === 'success' && syllabus.length > 0 && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col h-full max-w-5xl mx-auto"
              >
                <div className="flex flex-col gap-6 mb-8">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <h2 className="text-xl font-semibold text-white">Extracted Syllabus</h2>
                      <span className="text-xs bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 px-3 py-1 rounded-full font-medium">
                        {syllabus.length} Modules
                      </span>
                    </div>
                    
                    <div className="flex items-center gap-3">
                      <button 
                        onClick={exportToMarkdown}
                        className="flex items-center gap-2 text-sm bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 px-4 py-2 rounded-full text-white transition-all shadow-sm"
                      >
                        <Download className="w-4 h-4" />
                        <span>Export MD</span>
                      </button>
                      <button 
                        onClick={clearSyllabus}
                        className="flex items-center gap-2 text-sm bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 px-4 py-2 rounded-full text-red-400 transition-all shadow-sm"
                      >
                        <Trash2 className="w-4 h-4" />
                        <span className="hidden sm:inline">Clear</span>
                      </button>
                    </div>
                  </div>

                  {/* Resource Type Filter */}
                  <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-2">
                    <span className="text-xs font-semibold text-slate-500 uppercase tracking-widest mr-2">Filter</span>
                    {(['all', 'video', 'article', 'document', 'book'] as FilterType[]).map(f => (
                      <button
                        key={f}
                        onClick={() => setResourceFilter(f)}
                        className={`px-4 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                          resourceFilter === f 
                            ? 'bg-indigo-500 text-white shadow-[0_0_15px_rgba(99,102,241,0.4)]' 
                            : 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200 border border-white/5'
                        }`}
                      >
                        {f.charAt(0).toUpperCase() + f.slice(1)}s
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 pb-20">
                  {syllabus.map((mod, i) => (
                    <motion.div 
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.05 }}
                      key={i} 
                      className="group bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.08] hover:border-indigo-500/30 rounded-3xl p-6 flex flex-col gap-4 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_10px_40px_-10px_rgba(99,102,241,0.15)] relative overflow-hidden"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-indigo-400 tracking-wider uppercase">Module {i + 1}</span>
                        {mod.resources && mod.resources.length > 0 ? (
                          <span className="text-[10px] uppercase tracking-wider font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-1 rounded-full">Resources Found</span>
                        ) : (
                          <span className="text-[10px] uppercase tracking-wider font-bold bg-white/5 text-slate-400 border border-white/10 px-2 py-1 rounded-full">Pending</span>
                        )}
                      </div>
                      
                      <h3 className="text-lg font-semibold text-white/90 leading-snug">
                        {mod.title}
                      </h3>
                      
                      <p className="text-sm text-slate-400 leading-relaxed line-clamp-3 font-light">
                        {mod.description}
                      </p>

                      <div className="mt-auto pt-4 border-t border-white/[0.08]">
                        {mod.resources && mod.resources.length > 0 ? (
                          <div className="flex flex-col gap-3 mt-2">
                            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-1">Recommended Readings & Resources</h4>
                            {(() => {
                              const filteredResources = mod.resources.filter(res => {
                                if (resourceFilter === 'all') return true;
                                const t = res.type.toLowerCase();
                                if (resourceFilter === 'video') return t.includes('video') || t.includes('youtube');
                                if (resourceFilter === 'article') return t.includes('article') || t.includes('blog');
                                if (resourceFilter === 'document') return t.includes('pdf') || t.includes('ppt') || t.includes('document') || t.includes('slide');
                                if (resourceFilter === 'book') return t.includes('book');
                                return true;
                              });

                              if (filteredResources.length === 0) {
                                return <p className="text-xs text-slate-500 italic mt-2">No resources match the selected filter format.</p>;
                              }

                              return filteredResources.map((res, rIdx) => {
                                let urlObj;
                                try { urlObj = new URL(res.url); } catch { urlObj = { hostname: res.url }; }
                                return (
                                  <a 
                                    key={rIdx}
                                    href={res.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="group/res flex items-start gap-3 p-3 rounded-2xl bg-white/[0.03] border border-white/[0.05] hover:border-indigo-500/30 hover:bg-white/[0.06] transition-all"
                                  >
                                    <div className="mt-0.5 p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 group-hover/res:bg-indigo-500 group-hover/res:text-white transition-colors">
                                      {(res.type.toLowerCase().includes('video') || res.type.toLowerCase().includes('youtube')) ? (
                                        <Play className="w-4 h-4" />
                                      ) : (res.type.toLowerCase().includes('book') || res.type.toLowerCase().includes('doc')) ? (
                                        <BookOpen className="w-4 h-4" />
                                      ) : (res.type.toLowerCase().includes('pdf') || res.type.toLowerCase().includes('slide') || res.type.toLowerCase().includes('powerpoint')) ? (
                                        <FileText className="w-4 h-4" />
                                      ) : res.type.toLowerCase().includes('article') || res.type.toLowerCase().includes('blog') ? (
                                        <Globe className="w-4 h-4" />
                                      ) : (
                                        <LinkIcon className="w-4 h-4" />
                                      )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium text-white/90 truncate group-hover/res:text-indigo-300 transition-colors">{res.title}</p>
                                      <div className="flex items-center gap-2 mt-1">
                                        <span className="text-[10px] font-medium px-2 py-0.5 rounded border border-white/10 text-slate-400 bg-white/5 uppercase tracking-wider">{res.type}</span>
                                        <p className="text-xs text-slate-500 truncate flex-1">{urlObj.hostname.replace('www.', '')}</p>
                                      </div>
                                      {res.description && (
                                        <p className="mt-2 text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                                          {res.description}
                                        </p>
                                      )}
                                    </div>
                                  </a>
                                );
                              });
                            })()}
                          </div>
                        ) : (
                          <div className="flex-1 flex flex-col items-center justify-center p-6 bg-white/[0.02] rounded-2xl border border-dashed border-white/10">
                             <Globe className="w-8 h-8 opacity-20 text-slate-500 mb-2" />
                             <p className="text-sm text-slate-500 text-center">Resources pending search grounding</p>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </section>
        </main>
        
        {/* Status Footer */}
        <footer className="h-10 border-t border-white/[0.05] bg-black/20 backdrop-blur-xl px-6 lg:px-8 flex items-center justify-between text-xs text-slate-500 shrink-0">
          <div className="flex gap-6">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]"></span>
              Cache Storage
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-indigo-400 font-semibold tracking-wide hidden sm:inline">Gemini 3.1 Pro Integrated</span>
          </div>
        </footer>
      </div>

      {/* History Modal */}
      <AnimatePresence>
        {isHistoryOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsHistoryOpen(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-xl"
            />
            
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-2xl bg-[#09090b] border border-white/10 rounded-3xl shadow-[0_0_50px_rgba(0,0,0,0.5)] p-6 lg:p-8 max-h-[85vh] flex flex-col"
            >
              <button 
                onClick={() => setIsHistoryOpen(false)}
                className="absolute top-6 right-6 p-2 rounded-full bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
              
              <div className="mb-6 flex items-center justify-between pr-12">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-blue-500/10 text-blue-400 rounded-xl">
                    <History className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold text-white">Course History</h2>
                    <p className="text-sm text-slate-400">Recently generated learning paths</p>
                  </div>
                </div>
                {history.length > 0 && (
                  <button 
                    onClick={() => {
                      setHistory([]);
                      localStorage.removeItem('os_history');
                    }}
                    className="text-xs font-medium text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    Clear All
                  </button>
                )}
              </div>
              
              <div className="overflow-y-auto flex-1 space-y-3 pr-2 -mr-2">
                {history.length === 0 ? (
                  <div className="text-center py-16 px-4">
                    <div className="w-16 h-16 bg-white/[0.03] rounded-full flex items-center justify-center mx-auto mb-4 border border-white/5">
                      <History className="w-8 h-8 text-slate-500" />
                    </div>
                    <h3 className="text-base font-medium text-white mb-1">No History Yet</h3>
                    <p className="text-sm text-slate-400">Courses you generate will be saved here automatically.</p>
                  </div>
                ) : (
                  history.map(item => (
                    <div key={item.id} className="bg-white/[0.02] border border-white/[0.05] p-4 rounded-2xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 group hover:bg-white/[0.04] hover:border-white/10 transition-all">
                      <div className="flex-1 min-w-0">
                        <p className="text-base text-slate-200 font-medium truncate mb-1" title={item.url}>
                          {item.url.split('/').pop()?.replace(/-/g, ' ') || item.url.replace(/^https?:\/\/(www\.)?/, '')}
                        </p>
                        <div className="flex items-center gap-3 text-xs text-slate-500">
                          <span className="flex items-center gap-1"><BookOpen className="w-3.5 h-3.5" /> {item.syllabus.length} Modules</span>
                          <span>•</span>
                          <span>{new Date(item.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
                        <button 
                          onClick={() => {
                            setUrl(item.url);
                            setSyllabus(item.syllabus);
                            setRawModules(item.rawModules);
                            setStatus('success');
                            setIsHistoryOpen(false);
                          }} 
                          className="flex-1 sm:flex-none px-4 py-2 bg-indigo-500 border border-indigo-400/50 text-white hover:bg-indigo-400 rounded-xl text-sm font-medium transition-colors shadow-lg shadow-indigo-500/20"
                        >
                          Load Course
                        </button>
                        <button 
                          onClick={() => {
                            setHistory(prev => {
                              const next = prev.filter(i => i.id !== item.id);
                              localStorage.setItem('os_history', JSON.stringify(next));
                              return next;
                            });
                          }} 
                          className="p-2 text-slate-500 bg-white/5 hover:bg-red-500/20 hover:text-red-400 rounded-xl transition-colors border border-white/5 hover:border-red-500/30"
                          title="Remove"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    {/* Settings Modal */}
      <AnimatePresence>
        {isSettingsOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSettingsOpen(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-xl"
            />
            
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-lg bg-[#09090b] border border-white/10 rounded-3xl shadow-[0_0_50px_rgba(0,0,0,0.5)] p-6 lg:p-8 flex flex-col"
            >
              <button 
                onClick={() => setIsSettingsOpen(false)}
                className="absolute top-6 right-6 p-2 rounded-full bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
              
              <div className="mb-6 flex items-center gap-3 pr-12">
                <div className="p-2.5 bg-indigo-500/10 text-indigo-400 rounded-xl">
                  <Settings className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">API Integrations</h2>
                  <p className="text-sm text-slate-400">Bring your own keys to unlock accurate, deeper resource fetching.</p>
                </div>
              </div>
              
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">YouTube Data API v3 Key <span className="text-slate-500 font-normal">(Optional)</span></label>
                  <input 
                    type="password"
                    value={youtubeKey}
                    onChange={(e) => setYoutubeKey(e.target.value)}
                    placeholder="AIzaSy..."
                    className="w-full bg-white/[0.03] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                  />
                  <p className="text-xs text-slate-500 mt-2 leading-relaxed">Used to find exact high-quality lectures precisely matching topics. Keys are stored locally.</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Google Books API Key <span className="text-slate-500 font-normal">(Optional)</span></label>
                  <input 
                    type="password"
                    value={googleBooksKey}
                    onChange={(e) => setGoogleBooksKey(e.target.value)}
                    placeholder="AIzaSy..."
                    className="w-full bg-white/[0.03] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                  />
                  <p className="text-xs text-slate-500 mt-2 leading-relaxed">Used to accurately source textbook chapters and official written materials. Keys are stored locally.</p>
                </div>
              </div>

              <div className="mt-8 flex justify-end gap-3">
                <button 
                  onClick={() => setIsSettingsOpen(false)}
                  className="px-5 py-2.5 text-sm font-medium text-slate-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    localStorage.setItem('os_youtube_key', youtubeKey);
                    localStorage.setItem('os_google_books_key', googleBooksKey);
                    setIsSettingsOpen(false);
                  }}
                  className="px-5 py-2.5 bg-indigo-500 text-white rounded-xl text-sm font-medium hover:bg-indigo-400 transition-colors shadow-lg shadow-indigo-500/20 active:scale-95"
                >
                  Save Keys
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
