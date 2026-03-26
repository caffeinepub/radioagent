
import Map "mo:core/Map";
import Array "mo:core/Array";
import Order "mo:core/Order";
import Iter "mo:core/Iter";
import Time "mo:core/Time";
import Text "mo:core/Text";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Float "mo:core/Float";
import List "mo:core/List";
import MixinStorage "blob-storage/Mixin";
import MixinAuthorization "authorization/MixinAuthorization";
import Storage "blob-storage/Storage";
import AccessControl "authorization/access-control";


actor {
  // State
  type AnalysisId = Nat;
  type UserId = Principal;

  type Quality = {
    #good;
    #poor;
  };

  module Quality {
    public func toText(quality : Quality) : Text {
      switch (quality) {
        case (#good) { "Good" };
        case (#poor) { "Poor" };
      };
    };
  };

  type TriageStatus = {
    #normal;
    #critical;
  };

  module TriageStatus {
    public func toText(triageStatus : TriageStatus) : Text {
      switch (triageStatus) {
        case (#normal) { "Normal" };
        case (#critical) { "Critical" };
      };
    };
  };

  type Modality = {
    #ct;
    #mri;
  };

  module Modality {
    public func toText(modality : Modality) : Text {
      switch (modality) {
        case (#ct) { "CT" };
        case (#mri) { "MRI" };
      };
    };
  };

  public type AnalysisRecord = {
    id : AnalysisId;
    userId : UserId;
    patientName : Text;
    patientPhone : Text;
    findings : [Text];
    confidenceScores : [Float];
    triageStatus : TriageStatus;
    imageQuality : Quality;
    modality : Modality;
    reportText : Text;
    timestamp : Time.Time;
    image : Storage.ExternalBlob;
  };

  public type AnalysisInput = {
    patientName : Text;
    patientPhone : Text;
    findings : [Text];
    confidenceScores : [Float];
    triageStatus : TriageStatus;
    imageQuality : Quality;
    modality : Modality;
    reportText : Text;
    timestamp : Time.Time;
    image : Storage.ExternalBlob;
  };

  module AnalysisRecord {
    public func compare(analysis1 : AnalysisRecord, analysis2 : AnalysisRecord) : Order.Order {
      Nat.compare(analysis1.id, analysis2.id);
    };
  };

  public type UserProfile = {
    name : Text;
    // Other user metadata if needed
  };

  let analyses = Map.empty<AnalysisId, AnalysisRecord>();
  var nextAnalysisId : AnalysisId = 0;
  let accessControlState = AccessControl.initState();
  let userProfiles = Map.empty<Principal, UserProfile>();

  include MixinStorage();
  include MixinAuthorization(accessControlState);

  // Helper Functions
  func getCurrentUserProfileInternal(user : Principal) : UserProfile {
    switch (userProfiles.get(user)) {
      case (null) { Runtime.trap("User profile not found") };
      case (?profile) { profile };
    };
  };

  func getAnalysisInternal(analysisId : AnalysisId) : AnalysisRecord {
    switch (analyses.get(analysisId)) {
      case (null) { Runtime.trap("Analysis not found") };
      case (?analysis) { analysis };
    };
  };

  // User Profile Management
  public query ({ caller }) func getCallerUserProfile() : async ?UserProfile {
    if (not (AccessControl.hasPermission(accessControlState, caller, #user))) {
      Runtime.trap("Unauthorized: Only users can view profiles");
    };
    userProfiles.get(caller);
  };

  public query ({ caller }) func getUserProfile(user : Principal) : async ?UserProfile {
    if (caller != user and not AccessControl.isAdmin(accessControlState, caller)) {
      Runtime.trap("Unauthorized: Can only view your own profile");
    };
    userProfiles.get(user);
  };

  public shared ({ caller }) func saveCallerUserProfile(profile : UserProfile) : async () {
    if (not (AccessControl.hasPermission(accessControlState, caller, #user))) {
      Runtime.trap("Unauthorized: Only users can save profiles");
    };
    userProfiles.add(caller, profile);
  };

  // Register New Analysis
  public shared ({ caller }) func submitAnalysis(input : AnalysisInput) : async AnalysisId {
    if (not (AccessControl.hasPermission(accessControlState, caller, #user))) {
      Runtime.trap("Unauthorized: Only users can submit analyses");
    };
    let fullRecord : AnalysisRecord = {
      id = nextAnalysisId;
      userId = caller;
      patientName = input.patientName;
      patientPhone = input.patientPhone;
      findings = input.findings;
      confidenceScores = input.confidenceScores;
      triageStatus = input.triageStatus;
      imageQuality = input.imageQuality;
      modality = input.modality;
      reportText = input.reportText;
      timestamp = input.timestamp;
      image = input.image;
    };
    analyses.add(nextAnalysisId, fullRecord);
    let currentId = nextAnalysisId;
    nextAnalysisId += 1;
    currentId;
  };

  // Get Analysis By Id
  public query ({ caller }) func getAnalysis(analysisId : AnalysisId) : async AnalysisRecord {
    let analysis = getAnalysisInternal(analysisId);
    let isAdmin = AccessControl.isAdmin(accessControlState, caller);
    let isOwner = analysis.userId == caller;
    if (not (isOwner or isAdmin)) {
      Runtime.trap("Unauthorized: Can only view your own analysis");
    };
    analysis;
  };

  // Get All Analyses For User
  public query ({ caller }) func getMyAnalyses() : async [AnalysisRecord] {
    if (not (AccessControl.hasPermission(accessControlState, caller, #user))) {
      Runtime.trap("Unauthorized: Only users can view analyses");
    };
    analyses.values().toArray().sort().filter(func(a) { a.userId == caller });
  };

  public query func timeToText(time : Time.Time) : async Text {
    time.toText();
  };
};
