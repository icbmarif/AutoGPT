-- Add isHidden flag to LibraryAgent for trigger agents.
-- Trigger agents are hidden from the main library listing; their parent
-- agents are derived from AgentExecutorBlock usage in the trigger graph.
ALTER TABLE "LibraryAgent" ADD COLUMN "isHidden" BOOLEAN NOT NULL DEFAULT false;
