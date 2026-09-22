"""Questionnaire scoring: known-value anchors plus DNF/missing handling."""

from cabin_sim.questionnaire import compute_scores, ITEMS


def _all(ratings):
    return {d: [ratings] * 4 for d in ITEMS}


def test_compute_scores_known_anchor():
    out = compute_scores(_all(4))
    for d in ITEMS:
        assert out["subscales"][d] == 4.0
    assert out["factors"]["Capacity"] == 4.0
    assert out["factors"]["Moral"] == 4.0


def test_half_ratings_midpoint():
    out = compute_scores(_all(3.5))
    assert out["factors"]["Capacity"] == 3.5
    assert out["factors"]["Moral"] == 3.5


def test_dnf_missing_items_averaged_over_present():
    ratings = {d: [None, 3, 4, None] for d in ITEMS}
    out = compute_scores(ratings)
    for d in ITEMS:
        assert out["subscales"][d] == (3 + 4) / 2
    assert out["factors"]["Capacity"] == 3.5


def test_all_missing_yields_none_but_keeps_shape():
    ratings = {d: [None] * 4 for d in ITEMS}
    out = compute_scores(ratings)
    assert set(out["subscales"]) == set(ITEMS)
    for key in out["factors"]:
        assert out["factors"][key] is None