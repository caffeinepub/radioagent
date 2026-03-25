import type { Principal } from "@icp-sdk/core/principal";
export interface Some<T> {
    __kind__: "Some";
    value: T;
}
export interface None {
    __kind__: "None";
}
export type Option<T> = Some<T> | None;
export class ExternalBlob {
    getBytes(): Promise<Uint8Array<ArrayBuffer>>;
    getDirectURL(): string;
    static fromURL(url: string): ExternalBlob;
    static fromBytes(blob: Uint8Array<ArrayBuffer>): ExternalBlob;
    withUploadProgress(onProgress: (percentage: number) => void): ExternalBlob;
}
export type Time = bigint;
export interface AnalysisRecord {
    id: AnalysisId;
    imageQuality: Quality;
    userId: UserId;
    reportText: string;
    modality: Modality;
    triageStatus: TriageStatus;
    timestamp: Time;
    patientName: string;
    findings: Array<string>;
    image: ExternalBlob;
    confidenceScores: Array<number>;
}
export type UserId = Principal;
export interface AnalysisInput {
    imageQuality: Quality;
    reportText: string;
    modality: Modality;
    triageStatus: TriageStatus;
    timestamp: Time;
    patientName: string;
    findings: Array<string>;
    image: ExternalBlob;
    confidenceScores: Array<number>;
}
export type AnalysisId = bigint;
export interface UserProfile {
    name: string;
}
export enum Modality {
    ct = "ct",
    mri = "mri"
}
export enum Quality {
    good = "good",
    poor = "poor"
}
export enum TriageStatus {
    normal = "normal",
    critical = "critical"
}
export enum UserRole {
    admin = "admin",
    user = "user",
    guest = "guest"
}
export interface backendInterface {
    assignCallerUserRole(user: Principal, role: UserRole): Promise<void>;
    getAnalysis(analysisId: AnalysisId): Promise<AnalysisRecord>;
    getCallerUserProfile(): Promise<UserProfile | null>;
    getCallerUserRole(): Promise<UserRole>;
    getMyAnalyses(): Promise<Array<AnalysisRecord>>;
    getUserProfile(user: Principal): Promise<UserProfile | null>;
    isCallerAdmin(): Promise<boolean>;
    saveCallerUserProfile(profile: UserProfile): Promise<void>;
    submitAnalysis(input: AnalysisInput): Promise<AnalysisId>;
    timeToText(time: Time): Promise<string>;
}
