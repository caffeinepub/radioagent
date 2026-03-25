# Radioagent

## Current State
App views: upload, analysis, history. Nav: Dashboard, History tabs. AppView = upload|analysis|history. pastAnalyses (AnalysisRecord[]) available in App with: id, patientName, modality, triageStatus, timestamp, findings[], confidenceScores[].

## Requested Changes (Diff)

### Add
- Emergency Triage View (triage tab): critical cases filtered from pastAnalyses (triageStatus Critical/Critical-first). Columns: Case ID, Patient, Critical Findings, Time Since Scan (relative), Alert Sent badge.
- Hospital Dashboard View (hospital tab): stat cards for Turnaround Time (avg), AI Detection Accuracy (% cases avg confidence>=80), Doctor Workload (cases by triage status). Bar chart using recharts.

### Modify
- AppView type: add triage and hospital
- Nav tabs: add Emergency Triage (AlertTriangle icon) and Hospital Dashboard (BarChart3 icon)
- AnimatePresence: handle triage and hospital views

### Remove
- Nothing

## Implementation Plan
1. Extend AppView type
2. Add nav tabs
3. Build EmergencyTriageView component
4. Build HospitalDashboard component
5. Wire into AnimatePresence
6. Validate
