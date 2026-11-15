//! Kaxcav Vortex Core Engine (`vortex-core` v4.0.0)
//!
//! Production-grade native Rust indexing, graph, context compilation, failure slicing,
//! surgical AST editing, 15-category DLP scanning, and Drive Nexus vault engine.
//!
//! Traceability: `@REQ-VORTEX-001`, `@REQ-VORTEX-002`, `@REQ-VORTEX-003`, `@REQ-VORTEX-004`, `@REQ-VORTEX-005`.

pub const KAXCAV_VORTEX_VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod dlp;
pub mod editor;
pub mod engine;
pub mod federation;
pub mod graph;
pub mod kvxignore;
pub mod nexus;
pub mod packer;
pub mod parser;
pub mod slicer;
pub mod storage;
pub mod types;

pub use dlp::{DlpAllowEntry, DlpAllowlist, DlpScanner};
pub use editor::{SymbolEditor, TwoPhaseRenamer};
pub use engine::VortexEngine;
pub use federation::MultiRepoFederator;
pub use graph::CsrGraph;
pub use kvxignore::{KvxIgnore, KvxIgnoreError, KvxYamlConfig};
pub use nexus::DriveNexusVault;
pub use packer::{ReuseEnforcer, SubmodularPacker};
pub use parser::{AstParser, ParsedFile};
pub use slicer::FailureSlicer;
pub use storage::{SyncSummary, VortexShard};
pub use types::*;
