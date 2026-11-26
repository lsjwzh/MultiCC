//! Delivery-card projection. A workspace snapshot freezes the stopped checkout;
//! delivering code to the baseline instead requires a current integration or
//! an observed unchanged revision.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Attribution {
    Fixed,
    Candidate,
    Pending,
    Kept,
    Applied,
}

impl Attribution {
    pub fn mode(self) -> &'static str {
        match self {
            Self::Fixed => "fixed",
            Self::Candidate => "legacy_candidate",
            Self::Pending => "separation_pending",
            Self::Kept => "kept",
            Self::Applied => "separated",
        }
    }
    fn separation(self) -> bool {
        matches!(self, Self::Pending | Self::Kept | Self::Applied)
    }
}

pub struct DeliveryFacts {
    pub has_run: bool,
    pub succeeded: bool,
    pub code_observed: bool,
    pub code_changed: Option<bool>,
    pub has_integration: bool,
    pub integration_current: bool,
    pub snapshot: bool,
    pub snapshot_stopped: bool,
    pub barrier_current: bool,
    pub attribution: Attribution,
    pub fixed_attribution: bool,
    pub separation_applied: bool,
    pub stale_candidate: bool,
}

#[derive(Clone, Copy)]
pub enum Evidence {
    Run,
    UnchangedRun,
    Integration,
    Barrier,
    Attribution,
}

pub struct Step {
    pub key: &'static str,
    pub label: &'static str,
    pub status: &'static str,
    pub evidence: Evidence,
}

impl DeliveryFacts {
    fn delivered(&self) -> bool {
        if self.snapshot {
            self.snapshot_stopped
        } else {
            self.code_observed && (self.code_changed == Some(false) || self.integration_current)
        }
    }
    pub fn blockers(&self) -> Vec<&'static str> {
        let mut reasons = Vec::new();
        if self.stale_candidate {
            reasons.push("view_changed");
        }
        if !self.snapshot {
            if !self.has_run {
                reasons.push("final_run_result_required");
            } else {
                if !self.succeeded {
                    reasons.push("run_not_succeeded");
                }
                if !self.code_observed {
                    reasons.push("code_observation_required");
                }
            }
            if self.code_observed && self.code_changed != Some(false) {
                if !self.has_integration {
                    reasons.push("integration_receipt_required");
                } else if !self.integration_current {
                    reasons.push("baseline_revalidation_required");
                }
            }
        }
        if !self.barrier_current {
            reasons.push("source_writer_barrier_required");
        }
        if self.attribution == Attribution::Pending {
            reasons.push("separation_application_required");
        }
        reasons
    }

    pub fn steps(&self) -> [Step; 4] {
        let status = |done, blocked| {
            if done {
                "done"
            } else if blocked {
                "blocked"
            } else {
                "pending"
            }
        };
        let delivered = self.delivered();
        let (run, delivery) = if self.snapshot {
            (
                Step {
                    key: "run",
                    label: "源会话已停写",
                    status: status(self.barrier_current, true),
                    evidence: Evidence::Barrier,
                },
                Step {
                    key: "delivery",
                    label: "隔离基线已冻结",
                    status: status(delivered, true),
                    evidence: Evidence::Barrier,
                },
            )
        } else {
            (
                Step {
                    key: "run",
                    label: "本轮成功",
                    status: status(self.succeeded, self.has_run),
                    evidence: Evidence::Run,
                },
                Step {
                    key: "delivery",
                    label: "代码交付",
                    status: status(delivered, self.succeeded),
                    evidence: if self.code_changed == Some(false) {
                        Evidence::UnchangedRun
                    } else {
                        Evidence::Integration
                    },
                },
            )
        };
        [
            run,
            delivery,
            Step {
                key: "barrier",
                label: "源现场稳定",
                status: status(self.barrier_current, delivered),
                evidence: Evidence::Barrier,
            },
            Step {
                key: "attribution",
                label: if self.attribution.separation() {
                    "分离生效"
                } else {
                    "任务归属"
                },
                status: if self.separation_applied || self.fixed_attribution {
                    "done"
                } else if self.attribution == Attribution::Kept {
                    "skipped"
                } else {
                    "pending"
                },
                evidence: Evidence::Attribution,
            },
        ]
    }
}
