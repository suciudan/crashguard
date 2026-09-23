"""Exercise the same release predicate used by the deployment workflow."""

import copy
import json
from pathlib import Path
import subprocess
import unittest


FILTER = Path(__file__).resolve().parents[1] / 'scripts' / 'production-merge.jq'
REPO = 'suciudan/crashguard'
SHA = 'a' * 40


class ProductionMergeTests(unittest.TestCase):
    def setUp(self):
        self.pr = {
            'merged_at': '2026-09-23T14:26:34Z',
            'merge_commit_sha': SHA,
            'head': {'ref': 'main', 'repo': {'full_name': REPO}},
            'base': {'ref': 'production', 'repo': {'full_name': REPO}},
        }

    def eligible(self, pages):
        result = subprocess.run(
            ['jq', '--arg', 'sha', SHA, '--arg', 'repo', REPO, '-f', str(FILTER)],
            input=json.dumps(pages), capture_output=True, text=True, check=True,
        )
        return json.loads(result.stdout)

    def test_merge_result_is_eligible(self):
        self.assertTrue(self.eligible([[self.pr]]))

    def test_direct_push_with_no_pr_is_ineligible(self):
        self.assertFalse(self.eligible([[]]))

    def test_unmerged_pr_is_ineligible(self):
        self.pr['merged_at'] = None
        self.assertFalse(self.eligible([[self.pr]]))

    def test_pr_head_commit_is_not_the_release_commit(self):
        self.pr['merge_commit_sha'] = 'b' * 40
        self.assertFalse(self.eligible([[self.pr]]))

    def test_fork_and_other_branches_are_ineligible(self):
        for side, field, value in (
            ('head', 'repo', {'full_name': 'outsider/crashguard'}),
            ('base', 'repo', {'full_name': 'outsider/crashguard'}),
            ('head', 'ref', 'feature'),
            ('base', 'ref', 'main'),
        ):
            with self.subTest(side=side, field=field):
                pr = copy.deepcopy(self.pr)
                pr[side][field] = value
                self.assertFalse(self.eligible([[pr]]))

    def test_paginated_results(self):
        unrelated = {**self.pr, 'merge_commit_sha': 'b' * 40}
        self.assertTrue(self.eligible([[unrelated], [self.pr]]))


if __name__ == '__main__':
    unittest.main()
