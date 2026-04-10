"""Tests for OrchestratorBlock per-iteration cost charging.

The OrchestratorBlock in agent mode makes multiple LLM calls in a single
node execution. The executor uses ``Block.charge_per_llm_call`` to detect
this and charge ``base_cost * (llm_call_count - 1)`` extra credits after
the block completes.
"""

from unittest.mock import MagicMock

from backend.blocks.orchestrator import OrchestratorBlock


class TestChargePerLlmCallFlag:
    """OrchestratorBlock opts into per-LLM-call billing."""

    def test_orchestrator_opts_in(self):
        assert OrchestratorBlock.charge_per_llm_call is True

    def test_default_block_does_not_opt_in(self):
        from backend.blocks._base import Block

        assert Block.charge_per_llm_call is False


class TestChargeExtraIterations:
    """The executor charges ``cost * (llm_call_count - 1)`` extra credits."""

    def _make_processor_with_block_cost(self, base_cost: int):
        """Build a minimal ExecutionProcessor stub with a stubbed block lookup."""
        from backend.executor import manager

        proc = manager.ExecutionProcessor.__new__(manager.ExecutionProcessor)

        # Stub the spend_credits client and block_usage_cost helper.
        spent: list[int] = []

        class FakeDb:
            def spend_credits(self, *, user_id, cost, metadata):
                spent.append(cost)
                return 0

        # Patch get_db_client and get_block + block_usage_cost on the manager
        # module so charge_extra_iterations sees deterministic values.
        original_get_db = manager.get_db_client
        original_get_block = manager.get_block
        original_block_usage_cost = manager.block_usage_cost

        def restore():
            manager.get_db_client = original_get_db
            manager.get_block = original_get_block
            manager.block_usage_cost = original_block_usage_cost

        manager.get_db_client = lambda: FakeDb()
        manager.get_block = lambda block_id: MagicMock(name="block")
        manager.block_usage_cost = lambda block, input_data: (
            base_cost,
            {"model": "claude-sonnet-4-6"},
        )

        return proc, spent, restore

    def test_zero_extra_iterations_charges_nothing(self):
        proc, spent, restore = self._make_processor_with_block_cost(base_cost=10)
        try:
            node_exec = MagicMock()
            node_exec.user_id = "u"
            node_exec.graph_exec_id = "g"
            node_exec.graph_id = "g"
            node_exec.node_exec_id = "ne"
            node_exec.node_id = "n"
            node_exec.block_id = "b"
            node_exec.inputs = {}

            charged = proc.charge_extra_iterations(node_exec, extra_iterations=0)
            assert charged == 0
            assert spent == []
        finally:
            restore()

    def test_extra_iterations_multiplies_base_cost(self):
        proc, spent, restore = self._make_processor_with_block_cost(base_cost=10)
        try:
            node_exec = MagicMock()
            node_exec.user_id = "u"
            node_exec.graph_exec_id = "g"
            node_exec.graph_id = "g"
            node_exec.node_exec_id = "ne"
            node_exec.node_id = "n"
            node_exec.block_id = "b"
            node_exec.inputs = {}

            charged = proc.charge_extra_iterations(node_exec, extra_iterations=4)
            # 4 extra iterations × 10 base_cost = 40
            assert charged == 40
            assert spent == [40]
        finally:
            restore()

    def test_zero_base_cost_skips_charge(self):
        proc, spent, restore = self._make_processor_with_block_cost(base_cost=0)
        try:
            node_exec = MagicMock()
            node_exec.user_id = "u"
            node_exec.graph_exec_id = "g"
            node_exec.graph_id = "g"
            node_exec.node_exec_id = "ne"
            node_exec.node_id = "n"
            node_exec.block_id = "b"
            node_exec.inputs = {}

            charged = proc.charge_extra_iterations(node_exec, extra_iterations=4)
            assert charged == 0
            assert spent == []
        finally:
            restore()

    def test_negative_extra_iterations_charges_nothing(self):
        proc, spent, restore = self._make_processor_with_block_cost(base_cost=10)
        try:
            node_exec = MagicMock()
            node_exec.user_id = "u"
            node_exec.graph_exec_id = "g"
            node_exec.graph_id = "g"
            node_exec.node_exec_id = "ne"
            node_exec.node_id = "n"
            node_exec.block_id = "b"
            node_exec.inputs = {}

            charged = proc.charge_extra_iterations(node_exec, extra_iterations=-1)
            assert charged == 0
            assert spent == []
        finally:
            restore()
