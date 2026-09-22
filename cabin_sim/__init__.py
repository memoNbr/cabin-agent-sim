"""cabin-agent-sim: a cognitive agent with a persona inside a car interior.

Python-authoritative phase: SimEngine (cabin_sim.sim) is the clock/step driver
and schema.build_snapshot is the single external state contract.
"""

from .sim import SimEngine