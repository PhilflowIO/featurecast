"""Misst am FERTIGEN Video, wie glatt eine Bewegung von Bild zu Bild uebergeht.

Jede andere Zahl dieses Projekts ist ein Zaehler INNERHALB der Aufnahmekette
(src/efficiency.ts, src/presented.ts, src/cadence.ts) und sieht das fertige
MP4 nie an. 98,2 % Aufnahme-Effizienz und ein sichtbarer Haker sind kein
Widerspruch -- sie messen Verschiedenes. Dieses Werkzeug misst das Erzeugnis,
das der Owner beurteilt.

Einstieg: `smoothness.analyse.analysiere`. Aufrufzeilen: README.md.
Verfahren, Definition "Haker" und Grenzen: docs/SMOOTHNESS.md.
"""

from .analyse import analysiere
from .knobs import KNOBS, Knobs, erklaere

__all__ = ["KNOBS", "Knobs", "analysiere", "erklaere"]
