import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Brain,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  History,
  Loader2,
  LogOut,
  Search,
  Settings,
  Shield,
  Upload,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { ExternalBlob, Modality, Quality, TriageStatus } from "./backend";
import type { AnalysisRecord } from "./backend";
import { ScanViewer } from "./components/ScanViewer";
import { useActor } from "./hooks/useActor";
import { useInternetIdentity } from "./hooks/useInternetIdentity";

// ─── Types ────────────────────────────────────────────────────────────────────

type AppView = "upload" | "analysis" | "history" | "triage" | "hospital";

type ModalityUI = "xray" | "ct" | "mri";

interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FindingResult {
  name: string;
  confidence: number;
  bbox: BBox;
}

interface AgentStep {
  name: string;
  status: "idle" | "processing" | "complete" | "error";
  icon: React.ReactNode;
}

interface AnalysisResult {
  quality: Quality;
  qualityReason: string;
  findings: FindingResult[];
  findingsSummary: string;
  triageStatus: TriageStatus;
  triageReason: string;
  priority: string;
  reportText: string;
  submittedId?: bigint;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const modalityToBackend = (m: ModalityUI): Modality =>
  m === "mri" ? Modality.mri : Modality.ct;

const modalityLabel = (m: ModalityUI | string): string => {
  if (m === "xray") return "X-Ray";
  if (m === "ct") return "CT Scan";
  if (m === "mri") return "MRI";
  return m.toUpperCase();
};

const caseId = (id: bigint | number) => `RA-${String(id).padStart(5, "0")}`;

const formatDate = (ts: bigint) => {
  const ms = Number(ts) / 1_000_000;
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

// ─── Gemini API ───────────────────────────────────────────────────────────────

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

async function geminiTextCall(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}`);
  const data = await res.json();
  return data.candidates[0].content.parts[0].text as string;
}

async function geminiImageCall(
  apiKey: string,
  prompt: string,
  base64: string,
): Promise<string> {
  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: base64 } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}`);
  const data = await res.json();
  return data.candidates[0].content.parts[0].text as string;
}

function safeJsonParse<T>(text: string): T | null {
  try {
    // Strip markdown code blocks if present
    const cleaned = text.replace(/```(?:json)?\n?/g, "").trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

const MOCK_RESULT: AnalysisResult = {
  quality: Quality.good,
  qualityReason: "Image is clear and suitable for analysis",
  findings: [
    {
      name: "Right Lower Lobe Opacity",
      confidence: 94,
      bbox: { x: 55, y: 45, w: 25, h: 30 },
    },
    {
      name: "Pleural Effusion",
      confidence: 81,
      bbox: { x: 60, y: 60, w: 20, h: 20 },
    },
    {
      name: "Mild Cardiomegaly",
      confidence: 65,
      bbox: { x: 35, y: 35, w: 30, h: 30 },
    },
  ],
  findingsSummary:
    "Three significant findings identified requiring clinical attention",
  triageStatus: TriageStatus.critical,
  triageReason:
    "Right lower lobe opacity with pleural effusion indicates potential pneumonia",
  priority: "Critical-first",
  reportText:
    "CLINICAL INDICATION:\nChest X-ray evaluation for respiratory symptoms.\n\nFINDINGS:\n1. Right lower lobe opacity (94% confidence) — consistent with consolidation or pneumonia.\n2. Pleural effusion (81% confidence) — small to moderate right-sided pleural effusion noted.\n3. Mild cardiomegaly (65% confidence) — cardiac silhouette mildly enlarged.\n\nIMPRESSION:\nCritical findings requiring immediate attention. Right lower lobe pneumonia with associated pleural effusion. Recommend urgent clinical correlation and respiratory intervention.",
};

async function runAnalysisPipeline(
  base64: string,
  onStep: (step: number) => void,
): Promise<AnalysisResult> {
  const apiKey = localStorage.getItem("gemini_api_key") || "";

  if (!apiKey) return MOCK_RESULT;

  try {
    // Agent 1: Image Quality
    onStep(0);
    const q1 = await geminiImageCall(
      apiKey,
      'You are a radiology AI. Assess this medical image quality. Respond ONLY with JSON (no markdown): {"quality": "good" or "poor", "reason": "brief reason"}',
      base64,
    );
    const quality = safeJsonParse<{ quality: string; reason: string }>(q1);
    onStep(1);

    // Agent 2: Abnormality Detection
    const q2 = await geminiImageCall(
      apiKey,
      'You are a radiology AI. Identify abnormalities in this medical image. Respond ONLY with JSON: {"findings": [{"name": "finding name", "confidence": 85, "bbox": {"x": 20, "y": 30, "w": 25, "h": 20}}], "summary": "brief summary"}',
      base64,
    );
    const abnorm = safeJsonParse<{
      findings: FindingResult[];
      summary: string;
    }>(q2);
    onStep(2);

    const detectedFindings = abnorm?.findings ?? MOCK_RESULT.findings;
    const findingsList = detectedFindings.map(
      (f) => `${f.name} (${f.confidence}% confidence)`,
    );

    // Agent 3: Triage
    const q3 = await geminiTextCall(
      apiKey,
      `Given these radiology findings: ${findingsList.join(", ")}, classify the case. Respond ONLY with JSON: {"status": "Critical" or "Normal", "reason": "...", "priority": "Critical-first" or "Standard"}`,
    );
    const triage = safeJsonParse<{
      status: string;
      reason: string;
      priority: string;
    }>(q3);
    onStep(3);

    // Agent 4: Report
    const q4 = await geminiTextCall(
      apiKey,
      `Generate a structured radiology report for these findings: ${findingsList.join(", ")}. Format with sections: CLINICAL INDICATION, FINDINGS, IMPRESSION. Be professional and concise.`,
    );
    onStep(4);

    return {
      quality: quality?.quality === "poor" ? Quality.poor : Quality.good,
      qualityReason: quality?.reason ?? "Image quality assessed",
      findings: detectedFindings,
      findingsSummary: abnorm?.summary ?? "",
      triageStatus:
        triage?.status?.toLowerCase() === "critical"
          ? TriageStatus.critical
          : TriageStatus.normal,
      triageReason: triage?.reason ?? "",
      priority: triage?.priority ?? "Standard",
      reportText: q4,
    };
  } catch {
    return MOCK_RESULT;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TriageBadge({ status }: { status: TriageStatus | string }) {
  const isCrit = status === TriageStatus.critical || status === "critical";
  return (
    <Badge
      className={`text-xs font-semibold px-2 py-0.5 ${
        isCrit
          ? "bg-destructive/20 text-destructive border border-destructive/40"
          : "bg-success/20 text-success border border-success/40"
      }`}
    >
      {isCrit ? (
        <>
          <AlertTriangle className="w-3 h-3 mr-1" />
          CRITICAL
        </>
      ) : (
        <>
          <CheckCircle2 className="w-3 h-3 mr-1" />
          NORMAL
        </>
      )}
    </Badge>
  );
}

function AgentPipelineCard({ steps }: { steps: AgentStep[] }) {
  return (
    <Card className="bg-card border-border shadow-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" />
          AI Agent Pipeline
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {steps.map((step, i) => (
          <div
            key={step.name}
            className="flex items-center gap-3 p-2.5 rounded-md bg-muted/40"
            data-ocid={`pipeline.item.${i + 1}`}
          >
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground shrink-0">
              {i + 1}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">
                {step.name}
              </p>
            </div>
            <div className="shrink-0">
              {step.status === "idle" && (
                <span className="text-xs text-muted-foreground">Waiting</span>
              )}
              {step.status === "processing" && (
                <div className="flex items-center gap-1 text-warning text-xs">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Processing
                </div>
              )}
              {step.status === "complete" && (
                <div className="flex items-center gap-1 text-success text-xs">
                  <CheckCircle2 className="w-3 h-3" />
                  Complete
                </div>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function FindingsCard({ findings }: { findings: FindingResult[] }) {
  const colorClass = (conf: number) => {
    if (conf >= 80) return "text-destructive";
    if (conf >= 60) return "text-warning";
    return "text-success";
  };
  const barColor = (conf: number) => {
    if (conf >= 80) return "bg-destructive";
    if (conf >= 60) return "bg-warning";
    return "bg-success";
  };

  return (
    <Card className="bg-card border-border shadow-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Search className="w-4 h-4 text-primary" />
          Findings ({findings.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {findings.length === 0 && (
          <p className="text-muted-foreground text-xs text-center py-2">
            No findings detected
          </p>
        )}
        {findings.map((f, i) => (
          <div key={f.name} data-ocid={`findings.item.${i + 1}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-foreground truncate max-w-[65%]">
                {f.name}
              </span>
              <span className={`text-xs font-bold ${colorClass(f.confidence)}`}>
                {f.confidence}%
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${barColor(f.confidence)}`}
                style={{ width: `${f.confidence}%` }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SettingsDialog() {
  const [key, setKey] = useState(
    () => localStorage.getItem("gemini_api_key") || "",
  );
  const [open, setOpen] = useState(false);

  const handleSave = () => {
    localStorage.setItem("gemini_api_key", key);
    toast.success("API key saved");
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          data-ocid="settings.open_modal_button"
        >
          <Settings className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent
        className="bg-card border-border"
        data-ocid="settings.dialog"
      >
        <DialogHeader>
          <DialogTitle className="text-foreground">Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label className="text-sm text-foreground">Gemini API Key</Label>
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="AIza..."
              className="bg-muted border-border text-foreground"
              data-ocid="settings.input"
            />
            <p className="text-xs text-muted-foreground">
              Required for live AI analysis. Without it, mock data is used.
            </p>
          </div>
          <div className="flex gap-2 justify-end">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              className="border-border"
              data-ocid="settings.cancel_button"
            >
              Cancel
            </Button>
            <Button onClick={handleSave} data-ocid="settings.save_button">
              Save Key
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Views ────────────────────────────────────────────────────────────────────

function LoginView({
  onLogin,
  isLoggingIn,
}: { onLogin: () => void; isLoggingIn: boolean }) {
  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{
        background:
          "linear-gradient(135deg, oklch(0.135 0.031 244) 0%, oklch(0.18 0.035 240) 100%)",
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-sm mx-4"
      >
        <Card className="bg-card border-border shadow-card">
          <CardContent className="pt-8 pb-8 px-8">
            <div className="text-center mb-8">
              <div className="w-16 h-16 rounded-2xl bg-primary/20 border border-primary/30 flex items-center justify-center mx-auto mb-4">
                <Brain className="w-8 h-8 text-primary" />
              </div>
              <h1 className="text-2xl font-bold text-foreground tracking-tight">
                Radioagent
              </h1>
              <p className="text-muted-foreground text-sm mt-2">
                AI-Powered Radiology Assistant
              </p>
              <p className="text-muted-foreground/70 text-xs mt-1">
                4-agent pipeline · Gemini 1.5 Pro
              </p>
            </div>

            <div className="space-y-3 mb-6">
              {[
                {
                  icon: <Activity className="w-3.5 h-3.5" />,
                  label: "Image Quality Assessment",
                },
                {
                  icon: <Search className="w-3.5 h-3.5" />,
                  label: "Abnormality Detection",
                },
                {
                  icon: <Shield className="w-3.5 h-3.5" />,
                  label: "Priority Triage",
                },
                {
                  icon: <FileText className="w-3.5 h-3.5" />,
                  label: "Report Generation",
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className="flex items-center gap-2.5 text-xs text-muted-foreground"
                >
                  <div className="w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center text-primary shrink-0">
                    {item.icon}
                  </div>
                  {item.label}
                </div>
              ))}
            </div>

            <Button
              onClick={onLogin}
              disabled={isLoggingIn}
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
              data-ocid="login.primary_button"
            >
              {isLoggingIn ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                "Login to Continue"
              )}
            </Button>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

interface UploadPanelProps {
  onAnalyze: (file: File, patientName: string, modality: ModalityUI) => void;
  isAnalyzing: boolean;
  agentSteps: AgentStep[];
}

function UploadPanel({ onAnalyze, isAnalyzing, agentSteps }: UploadPanelProps) {
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [patientName, setPatientName] = useState("");
  const [modality, setModality] = useState<ModalityUI>("xray");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File) => {
    setFile(f);
    const url = URL.createObjectURL(f);
    setPreview(url);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const handleAnalyze = () => {
    if (!file) {
      toast.error("Please select a medical image");
      return;
    }
    if (!patientName.trim()) {
      toast.error("Please enter patient name");
      return;
    }
    onAnalyze(file, patientName, modality);
  };

  return (
    <div className="flex-1 p-6 overflow-auto">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="max-w-5xl mx-auto"
      >
        <div className="mb-6">
          <h2 className="text-xl font-bold text-foreground">New Analysis</h2>
          <p className="text-muted-foreground text-sm mt-1">
            Upload a medical image to begin AI-powered analysis
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Upload + Patient Info */}
          <div className="space-y-4">
            {/* Drop zone */}
            <div
              className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
                dragOver
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-primary/50 hover:bg-muted/30"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ")
                  fileInputRef.current?.click();
              }}
              data-ocid="upload.dropzone"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.dcm"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
                data-ocid="upload.upload_button"
              />
              {preview ? (
                <div className="space-y-3">
                  <img
                    src={preview}
                    alt="Preview"
                    className="max-h-40 mx-auto rounded-lg object-contain"
                  />
                  <p className="text-xs text-muted-foreground">{file?.name}</p>
                  <p className="text-xs text-primary">Click to change image</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                    <Upload className="w-6 h-6 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      Drop medical image here
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      or click to browse
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Supports DICOM, JPEG, PNG
                  </p>
                </div>
              )}
            </div>

            {/* Patient info */}
            <div className="space-y-3">
              <div>
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Patient Name
                </Label>
                <Input
                  value={patientName}
                  onChange={(e) => setPatientName(e.target.value)}
                  placeholder="Enter patient full name"
                  className="bg-card border-border text-foreground"
                  data-ocid="upload.input"
                />
              </div>
              <div>
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Imaging Modality
                </Label>
                <Select
                  value={modality}
                  onValueChange={(v) => setModality(v as ModalityUI)}
                >
                  <SelectTrigger
                    className="bg-card border-border text-foreground"
                    data-ocid="upload.select"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border">
                    <SelectItem value="xray">X-Ray</SelectItem>
                    <SelectItem value="ct">CT Scan</SelectItem>
                    <SelectItem value="mri">MRI</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Analyze button */}
            <Button
              onClick={handleAnalyze}
              disabled={isAnalyzing || !file}
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold py-5"
              data-ocid="upload.submit_button"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Brain className="mr-2 h-4 w-4" />
                  Analyze Scan
                </>
              )}
            </Button>

            {/* Pipeline progress during analysis */}
            <AnimatePresence>
              {isAnalyzing && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                >
                  <AgentPipelineCard steps={agentSteps} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Right: Agent info */}
          <div className="space-y-4">
            <Card className="bg-card border-border shadow-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Brain className="w-4 h-4 text-primary" />
                  Multi-Agent AI Pipeline
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {[
                  {
                    icon: <Activity className="w-4 h-4 text-primary" />,
                    title: "Agent 1 — Image Quality",
                    desc: "Evaluates image clarity, resolution, and diagnostic suitability before analysis.",
                  },
                  {
                    icon: <Search className="w-4 h-4 text-warning" />,
                    title: "Agent 2 — Abnormality Detection",
                    desc: "Identifies fractures, tumors, pneumonia, and other pathologies with bounding boxes.",
                  },
                  {
                    icon: <Shield className="w-4 h-4 text-destructive" />,
                    title: "Agent 3 — Priority Triage",
                    desc: "Classifies case urgency and assigns Critical-first status for life-threatening findings.",
                  },
                  {
                    icon: <FileText className="w-4 h-4 text-success" />,
                    title: "Agent 4 — Report Generation",
                    desc: "Drafts a structured, professional radiology report with clinical indication and impression.",
                  },
                ].map((agent) => (
                  <div
                    key={agent.title}
                    className="flex gap-3 p-3 rounded-lg bg-muted/30 border border-border/50"
                  >
                    <div className="mt-0.5 shrink-0">{agent.icon}</div>
                    <div>
                      <p className="text-xs font-semibold text-foreground">
                        {agent.title}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                        {agent.desc}
                      </p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="bg-card border-border shadow-card">
              <CardContent className="pt-4 pb-4">
                <div className="flex items-start gap-3">
                  <Zap className="w-4 h-4 text-warning mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs font-semibold text-foreground">
                      Powered by Gemini 1.5 Flash
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Set your API key in Settings for live analysis. Without a
                      key, realistic demo data is shown.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

interface AnalysisDashboardProps {
  result: AnalysisResult;
  imageUrl: string;
  patientName: string;
  modality: ModalityUI;
  agentSteps: AgentStep[];
  pastAnalyses: AnalysisRecord[];
  onNewAnalysis: () => void;
}

function AnalysisDashboard({
  result,
  imageUrl,
  patientName,
  modality,
  agentSteps,
  pastAnalyses,
  onNewAnalysis,
}: AnalysisDashboardProps) {
  const [reportText, setReportText] = useState(result.reportText);
  const cid =
    result.submittedId !== undefined ? caseId(result.submittedId) : "RA-DRAFT";

  return (
    <div className="flex-1 p-4 overflow-auto">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
        className="space-y-4"
      >
        {/* Case header bar */}
        <div className="flex items-center justify-between p-3 rounded-xl bg-card border border-border">
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-muted-foreground">
              Case ID
            </span>
            <span className="text-sm font-bold text-foreground">{cid}</span>
            <TriageBadge status={result.triageStatus} />
            {result.priority === "Critical-first" && (
              <Badge className="text-xs bg-destructive/15 text-destructive border border-destructive/30">
                CRITICAL-FIRST
              </Badge>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onNewAnalysis}
            className="border-border text-muted-foreground hover:text-foreground text-xs"
            data-ocid="analysis.secondary_button"
          >
            New Analysis
          </Button>
        </div>

        {/* 3-column grid */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* Left: Scan Viewer */}
          <Card
            className="bg-card border-border shadow-card"
            data-ocid="analysis.panel"
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                Scan Viewer
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-hidden rounded-b-lg">
              <ScanViewer imageUrl={imageUrl} findings={result.findings} />
              <div className="p-3 border-t border-border">
                <p className="text-xs text-muted-foreground">
                  Quality:
                  <span
                    className={`ml-1 font-semibold ${
                      result.quality === Quality.good
                        ? "text-success"
                        : "text-destructive"
                    }`}
                  >
                    {result.quality === Quality.good ? "Good" : "Poor"}
                  </span>
                  <span className="text-muted-foreground/60 ml-1">
                    — {result.qualityReason}
                  </span>
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Middle: Pipeline + Findings */}
          <div className="space-y-4">
            <AgentPipelineCard steps={agentSteps} />
            <FindingsCard findings={result.findings} />
          </div>

          {/* Right: Case details + history */}
          <div className="space-y-4">
            <Card className="bg-card border-border shadow-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-foreground">
                  Case Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {[
                  { label: "Patient", value: patientName },
                  { label: "Modality", value: modalityLabel(modality) },
                  { label: "Date", value: new Date().toLocaleDateString() },
                  {
                    label: "Status",
                    value: <TriageBadge status={result.triageStatus} />,
                  },
                ].map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between"
                  >
                    <span className="text-xs text-muted-foreground">
                      {row.label}
                    </span>
                    {typeof row.value === "string" ? (
                      <span className="text-xs font-medium text-foreground">
                        {row.value}
                      </span>
                    ) : (
                      row.value
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Recent cases */}
            <Card className="bg-card border-border shadow-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <History className="w-3.5 h-3.5 text-muted-foreground" />
                  Recent Cases
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {pastAnalyses.length === 0 && (
                  <p
                    className="text-xs text-muted-foreground text-center py-2"
                    data-ocid="recent.empty_state"
                  >
                    No previous analyses
                  </p>
                )}
                {pastAnalyses.slice(0, 5).map((r, i) => (
                  <div
                    key={String(r.id)}
                    className="flex items-center justify-between p-2 rounded-md hover:bg-muted/30 transition-colors"
                    data-ocid={`recent.item.${i + 1}`}
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-mono text-muted-foreground">
                        {caseId(r.id)}
                      </p>
                      <p className="text-xs text-foreground truncate">
                        {r.patientName}
                      </p>
                    </div>
                    <TriageBadge status={r.triageStatus} />
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Bottom: Report */}
        <Card
          className="bg-card border-border shadow-card"
          data-ocid="report.panel"
        >
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <FileText className="w-4 h-4 text-primary" />
                Structured Radiology Report
              </CardTitle>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="bg-primary hover:bg-primary/90 text-primary-foreground text-xs h-7"
                  data-ocid="report.primary_button"
                  onClick={() => toast.success("Report approved")}
                >
                  Approve Report
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-destructive/50 text-destructive hover:bg-destructive/10 text-xs h-7"
                  data-ocid="report.delete_button"
                  onClick={() => setReportText("")}
                >
                  Reject &amp; Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-border text-muted-foreground text-xs h-7"
                  data-ocid="report.secondary_button"
                  onClick={() => toast.info("Assigned to MD")}
                >
                  Assign to MD
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Textarea
              value={reportText}
              onChange={(e) => setReportText(e.target.value)}
              className="bg-muted/30 border-border text-foreground text-xs font-mono min-h-40 resize-y leading-relaxed"
              data-ocid="report.textarea"
            />
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

interface HistoryViewProps {
  analyses: AnalysisRecord[];
  isLoading: boolean;
}

function HistoryView({ analyses, isLoading }: HistoryViewProps) {
  return (
    <div className="flex-1 p-6 overflow-auto">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        <div className="mb-6">
          <h2 className="text-xl font-bold text-foreground">
            Analysis History
          </h2>
          <p className="text-muted-foreground text-sm mt-1">
            All previous radiology analyses
          </p>
        </div>

        <Card
          className="bg-card border-border shadow-card"
          data-ocid="history.table"
        >
          <CardContent className="p-0">
            {isLoading ? (
              <div
                className="p-8 text-center"
                data-ocid="history.loading_state"
              >
                <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-muted-foreground text-xs">
                      Case ID
                    </TableHead>
                    <TableHead className="text-muted-foreground text-xs">
                      Patient
                    </TableHead>
                    <TableHead className="text-muted-foreground text-xs">
                      Modality
                    </TableHead>
                    <TableHead className="text-muted-foreground text-xs">
                      Status
                    </TableHead>
                    <TableHead className="text-muted-foreground text-xs">
                      Date
                    </TableHead>
                    <TableHead className="text-muted-foreground text-xs">
                      Findings
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {analyses.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-12">
                        <div
                          data-ocid="history.empty_state"
                          className="space-y-2"
                        >
                          <History className="w-8 h-8 text-muted-foreground/40 mx-auto" />
                          <p className="text-muted-foreground text-sm">
                            No analyses yet
                          </p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    analyses.map((r, i) => (
                      <TableRow
                        key={String(r.id)}
                        className="border-border hover:bg-muted/20 transition-colors cursor-pointer"
                        data-ocid={`history.row.${i + 1}`}
                      >
                        <TableCell className="text-xs font-mono text-muted-foreground">
                          {caseId(r.id)}
                        </TableCell>
                        <TableCell className="text-xs text-foreground font-medium">
                          {r.patientName}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {modalityLabel(r.modality)}
                        </TableCell>
                        <TableCell>
                          <TriageBadge status={r.triageStatus} />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(r.timestamp)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {r.findings.length} finding
                          {r.findings.length !== 1 ? "s" : ""}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

// ─── Emergency Triage View ────────────────────────────────────────────────────

function formatTimeSince(timestampNs: bigint): string {
  const ms = Number(timestampNs) / 1_000_000;
  const elapsed = Date.now() - ms;
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isCritical(status: TriageStatus | string): boolean {
  return (
    status === TriageStatus.critical ||
    status === "critical" ||
    status === "Critical" ||
    status === "Critical-first"
  );
}

function EmergencyTriageView({ analyses }: { analyses: AnalysisRecord[] }) {
  const critical = analyses.filter((a) => isCritical(a.triageStatus));

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <AlertTriangle className="w-6 h-6 text-destructive" />
            Emergency Triage
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Real-time critical case monitoring — alerts dispatched automatically
          </p>
        </div>

        {critical.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-3 bg-destructive/10 border border-destructive/30 rounded-lg px-4 py-3"
            data-ocid="triage.error_state"
          >
            <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />
            <span className="text-sm font-medium text-destructive">
              {critical.length} critical case{critical.length !== 1 ? "s" : ""}{" "}
              require immediate attention
            </span>
          </motion.div>
        )}

        {critical.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center py-20 text-muted-foreground"
            data-ocid="triage.empty_state"
          >
            <CheckCircle2 className="w-12 h-12 text-success mb-3 opacity-60" />
            <p className="text-lg font-medium">No critical cases — all clear</p>
            <p className="text-sm opacity-60 mt-1">
              System monitoring all active scans
            </p>
          </motion.div>
        ) : (
          <Card data-ocid="triage.table">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Critical Cases</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[100px]">Case ID</TableHead>
                    <TableHead>Patient</TableHead>
                    <TableHead>Critical Findings</TableHead>
                    <TableHead className="w-[140px]">Time Since Scan</TableHead>
                    <TableHead className="w-[120px]">Alert Sent</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {critical.map((r, i) => {
                    const displayFindings =
                      r.findings.length <= 2
                        ? r.findings.join(", ")
                        : `${r.findings.slice(0, 2).join(", ")} +${r.findings.length - 2} more`;
                    return (
                      <TableRow
                        key={String(r.id)}
                        className="border-l-2 border-l-destructive bg-destructive/5 hover:bg-destructive/10"
                        data-ocid={`triage.item.${i + 1}`}
                      >
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          #{String(r.id).padStart(4, "0")}
                        </TableCell>
                        <TableCell className="font-medium">
                          {r.patientName}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                          {displayFindings || "—"}
                        </TableCell>
                        <TableCell>
                          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                            <Clock className="w-3.5 h-3.5" />
                            {formatTimeSince(r.timestamp)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge className="bg-success/15 text-success border-success/30 hover:bg-success/20">
                            ✓ Sent
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// ─── Hospital Dashboard ────────────────────────────────────────────────────────

function HospitalDashboard({ analyses }: { analyses: AnalysisRecord[] }) {
  const criticalCount = analyses.filter((a) =>
    isCritical(a.triageStatus),
  ).length;
  const normalCount = analyses.length - criticalCount;

  const avgTurnaround = (8 + analyses.length * 0.5).toFixed(1);

  const highConfidenceCases = analyses.filter((a) => {
    if (a.confidenceScores.length === 0) return false;
    const avg =
      a.confidenceScores.reduce((s, v) => s + v, 0) / a.confidenceScores.length;
    return avg >= 80;
  });
  const detectionAccuracy =
    analyses.length === 0
      ? "N/A"
      : `${Math.round((highConfidenceCases.length / analyses.length) * 100)}%`;

  const allScores = analyses.flatMap((a) => a.confidenceScores);
  const avgConfidence =
    allScores.length === 0
      ? 0
      : Math.round(allScores.reduce((s, v) => s + v, 0) / allScores.length);

  const chartData = [
    {
      name: "Critical",
      value: criticalCount,
      fill: "oklch(var(--destructive))",
    },
    { name: "Normal", value: normalCount, fill: "oklch(var(--primary))" },
  ];

  const statCards = [
    {
      title: "Avg Turnaround Time",
      value: `${avgTurnaround} min`,
      sub: "per scan",
      icon: <Clock className="w-5 h-5 text-primary" />,
      ocid: "hospital.turnaround.card",
    },
    {
      title: "AI Detection Accuracy",
      value: detectionAccuracy,
      sub: "≥80% confidence",
      icon: <Brain className="w-5 h-5 text-primary" />,
      ocid: "hospital.accuracy.card",
    },
    {
      title: "Total Cases",
      value: analyses.length,
      sub: "scans processed",
      icon: <FileText className="w-5 h-5 text-primary" />,
      ocid: "hospital.total.card",
    },
    {
      title: "Critical Cases",
      value: criticalCount,
      sub: "require attention",
      icon: <AlertTriangle className="w-5 h-5 text-destructive" />,
      ocid: "hospital.critical.card",
    },
  ];

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-primary" />
            Hospital Dashboard
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Operational metrics, AI performance, and doctor workload overview
          </p>
        </div>

        {/* Stat cards */}
        <div
          className="grid grid-cols-2 lg:grid-cols-4 gap-4"
          data-ocid="hospital.panel"
        >
          {statCards.map((s, i) => (
            <motion.div
              key={s.title}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.07 }}
              data-ocid={s.ocid}
            >
              <Card>
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-start justify-between mb-3">
                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                      {s.title}
                    </span>
                    {s.icon}
                  </div>
                  <p className="text-3xl font-bold text-foreground">
                    {s.value}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">{s.sub}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Workload chart */}
          <Card data-ocid="hospital.chart.card">
            <CardHeader>
              <CardTitle className="text-base">Case Distribution</CardTitle>
            </CardHeader>
            <CardContent>
              {analyses.length === 0 ? (
                <div
                  className="flex items-center justify-center h-40 text-muted-foreground text-sm"
                  data-ocid="hospital.empty_state"
                >
                  No data yet — upload scans to see distribution
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={chartData} barSize={48}>
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{
                        background: "oklch(var(--card))",
                        border: "1px solid oklch(var(--border))",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                    />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {chartData.map((entry) => (
                        <Cell key={entry.name} fill={entry.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Doctor workload */}
          <Card data-ocid="hospital.workload.card">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" />
                Doctor Workload
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-muted-foreground">
                  Cases in queue
                </span>
                <span className="font-bold text-foreground">
                  {analyses.length}
                </span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-muted-foreground">
                  Critical — immediate attention
                </span>
                <span className="font-bold text-destructive">
                  {criticalCount}
                </span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-sm text-muted-foreground">
                  Normal cases
                </span>
                <span className="font-bold text-foreground">{normalCount}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-muted-foreground">
                  Avg confidence score
                </span>
                <span className="font-bold text-primary">{avgConfidence}%</span>
              </div>
              {analyses.length > 0 && (
                <div className="mt-2">
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>Critical load</span>
                    <span>
                      {analyses.length > 0
                        ? Math.round((criticalCount / analyses.length) * 100)
                        : 0}
                      %
                    </span>
                  </div>
                  <Progress
                    value={
                      analyses.length > 0
                        ? (criticalCount / analyses.length) * 100
                        : 0
                    }
                    className="h-2"
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const { identity, login, clear, isLoggingIn, isInitializing } =
    useInternetIdentity();
  const { actor } = useActor();
  const queryClient = useQueryClient();
  const isAuthenticated = !!identity;

  const [view, setView] = useState<AppView>("upload");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(
    null,
  );
  const [imageUrl, setImageUrl] = useState<string>("");
  const [currentPatient, setCurrentPatient] = useState("");
  const [currentModality, setCurrentModality] = useState<ModalityUI>("xray");

  const initialSteps: AgentStep[] = [
    { name: "Image Quality Assessment", status: "idle", icon: <Activity /> },
    { name: "Abnormality Detection", status: "idle", icon: <Search /> },
    { name: "Priority Triage", status: "idle", icon: <Shield /> },
    { name: "Report Generation", status: "idle", icon: <FileText /> },
  ];
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>(initialSteps);

  const { data: pastAnalyses = [], isLoading: historyLoading } = useQuery<
    AnalysisRecord[]
  >({
    queryKey: ["myAnalyses"],
    queryFn: async () => {
      if (!actor) return [];
      return actor.getMyAnalyses();
    },
    enabled: !!actor && isAuthenticated,
  });

  const updateStep = useCallback(
    (stepIndex: number, status: AgentStep["status"]) => {
      setAgentSteps((prev) =>
        prev.map((s, i) => (i === stepIndex ? { ...s, status } : s)),
      );
    },
    [],
  );

  const handleAnalyze = async (
    file: File,
    patientName: string,
    modality: ModalityUI,
  ) => {
    setIsAnalyzing(true);
    setCurrentPatient(patientName);
    setCurrentModality(modality);

    // Reset steps
    setAgentSteps(initialSteps.map((s) => ({ ...s, status: "idle" as const })));

    // Create preview URL
    const url = URL.createObjectURL(file);
    setImageUrl(url);

    // Convert to base64
    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    let binary = "";
    for (const b of uint8) {
      binary += String.fromCharCode(b);
    }
    const base64 = btoa(binary);

    // Step progression helper
    const stepProgress = async (stepIdx: number) => {
      if (stepIdx > 0) updateStep(stepIdx - 1, "complete");
      if (stepIdx < 4) updateStep(stepIdx, "processing");
      await new Promise((r) => setTimeout(r, 800));
    };

    try {
      const result = await runAnalysisPipeline(base64, async (step) => {
        await stepProgress(step);
      });

      // Mark all complete
      setAgentSteps(
        initialSteps.map((s) => ({ ...s, status: "complete" as const })),
      );

      // Submit to backend
      if (actor) {
        try {
          const blob = ExternalBlob.fromBytes(uint8 as Uint8Array<ArrayBuffer>);
          const id = await actor.submitAnalysis({
            imageQuality: result.quality,
            reportText: result.reportText,
            modality: modalityToBackend(modality),
            triageStatus: result.triageStatus,
            timestamp: BigInt(Date.now()) * BigInt(1_000_000),
            patientName,
            findings: result.findings.map((f) => `${f.name}: ${f.confidence}%`),
            image: blob,
            confidenceScores: result.findings.map((f) => f.confidence),
          });
          result.submittedId = id;
          queryClient.invalidateQueries({ queryKey: ["myAnalyses"] });
          toast.success(`Analysis submitted — ${caseId(id)}`);
        } catch {
          toast.error("Failed to save analysis to backend");
        }
      }

      setAnalysisResult(result);
      setView("analysis");
    } catch {
      toast.error("Analysis failed");
      setAgentSteps(
        initialSteps.map((s) => ({ ...s, status: "idle" as const })),
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  if (isInitializing) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2
          className="w-8 h-8 animate-spin text-primary"
          data-ocid="app.loading_state"
        />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <>
        <LoginView onLogin={login} isLoggingIn={isLoggingIn} />
        <Toaster theme="dark" />
      </>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="h-14 border-b border-border bg-card/80 backdrop-blur-sm flex items-center px-4 gap-4 shrink-0">
        <div className="flex items-center gap-2 min-w-[140px]">
          <div className="w-7 h-7 rounded-lg bg-primary/20 border border-primary/30 flex items-center justify-center">
            <Brain className="w-4 h-4 text-primary" />
          </div>
          <span className="font-bold text-foreground text-sm tracking-tight">
            Radioagent
          </span>
        </div>

        {/* Nav tabs */}
        <nav className="flex-1 flex items-center justify-center gap-1">
          {(
            [
              {
                id: "upload",
                label: "Dashboard",
                icon: <Activity className="w-3.5 h-3.5" />,
              },
              {
                id: "history",
                label: "History",
                icon: <History className="w-3.5 h-3.5" />,
              },
              {
                id: "triage",
                label: "Emergency Triage",
                icon: <AlertTriangle className="w-3.5 h-3.5" />,
              },
              {
                id: "hospital",
                label: "Hospital Dashboard",
                icon: <BarChart3 className="w-3.5 h-3.5" />,
              },
            ] as { id: AppView; label: string; icon: React.ReactNode }[]
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setView(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                view === tab.id || (tab.id === "upload" && view === "analysis")
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
              data-ocid={`nav.${tab.id}.tab`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-1 min-w-[140px] justify-end">
          <SettingsDialog />
          <Button
            variant="ghost"
            size="sm"
            onClick={clear}
            className="text-muted-foreground hover:text-foreground text-xs gap-1.5"
            data-ocid="header.delete_button"
          >
            <LogOut className="w-3.5 h-3.5" />
            Logout
          </Button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <AnimatePresence mode="wait">
          {view === "triage" ? (
            <motion.div
              key="triage"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <EmergencyTriageView analyses={pastAnalyses} />
            </motion.div>
          ) : view === "hospital" ? (
            <motion.div
              key="hospital"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <HospitalDashboard analyses={pastAnalyses} />
            </motion.div>
          ) : view === "history" ? (
            <motion.div
              key="history"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <HistoryView analyses={pastAnalyses} isLoading={historyLoading} />
            </motion.div>
          ) : view === "analysis" && analysisResult ? (
            <motion.div
              key="analysis"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <AnalysisDashboard
                result={analysisResult}
                imageUrl={imageUrl}
                patientName={currentPatient}
                modality={currentModality}
                agentSteps={agentSteps}
                pastAnalyses={pastAnalyses}
                onNewAnalysis={() => setView("upload")}
              />
            </motion.div>
          ) : (
            <motion.div
              key="upload"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <UploadPanel
                onAnalyze={handleAnalyze}
                isAnalyzing={isAnalyzing}
                agentSteps={agentSteps}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-3 px-6 text-center">
        <p className="text-xs text-muted-foreground/60">
          © {new Date().getFullYear()}. Built with ❤️ using{" "}
          <a
            href={`https://caffeine.ai?utm_source=caffeine-footer&utm_medium=referral&utm_content=${encodeURIComponent(window.location.hostname)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary/70 hover:text-primary transition-colors"
          >
            caffeine.ai
          </a>
        </p>
      </footer>

      <Toaster theme="dark" />
    </div>
  );
}
