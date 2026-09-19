//! AfterTerm PTY session manager and production command gate.

pub mod context;
pub mod destructive;
pub mod gate;
pub mod path;
pub mod session;

pub use context::{gather, looks_like_production, target, ActiveContext};
pub use destructive::{answered, challenge_for, is_destructive, is_infra_apply, Challenge};
pub use gate::{challenge_for_line, line_is_destructive, LineTracker, Step};
pub use session::{
    HoldResolution, SessionId, SessionInfo, SessionManager, Sink, SpawnOpts, WriteOutcome,
};
