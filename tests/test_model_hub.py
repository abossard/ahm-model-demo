import asyncio
import copy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

from azure.core.exceptions import ClientAuthenticationError, HttpResponseError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import live_data  # noqa: E402
import model_hub  # noqa: E402

SELECTION = ("sub", "rg", "hm")
FAST = dict(poll_seconds=0.01, grace_seconds=0.05, access_recheck_seconds=0.02, annotation_seconds=3600)


def entity(name, state="Healthy", at="2026-11-11T10:00:00Z", value=1.0):
    return {
        "name": name,
        "displayName": name,
        "healthState": state,
        "signals": [{"name": "cpu", "healthState": state, "value": value, "reportedAt": at}],
    }


def inventory(*entities):
    return {"model": {"name": "hm", "healthState": "Healthy"}, "observedAt": "t", "entities": list(entities), "relationships": [], "reportOptions": {}}


def http_error(status):
    error = HttpResponseError(message="x")
    error.status_code = status
    return error


class Azure:
    """A fake CloudHealth: the state it shows, who reads it, and what fails."""

    def __init__(self, *entities):
        self.state = inventory(*(entities or (entity("a"), entity("b"))))
        self.reads = []
        self.errors = {}
        self.tails = []
        self.tail_result = {}
        self.tail_error = None

    def read_state(self, user, selection):
        self.reads.append(user.oid)
        if user.oid in self.errors:
            raise self.errors[user.oid]
        return copy.deepcopy(self.state), {}

    def read_tail(self, user, selection, since, annotations):
        self.tails.append((user.oid, dict(since), annotations))
        if self.tail_error:
            raise self.tail_error
        return copy.deepcopy(self.tail_result)

    def change(self, *entities):
        self.state = inventory(*entities)


def person(oid, allowed=True):
    user = SimpleNamespace(oid=oid, allowed=allowed)
    user.has_model = lambda *_: user.allowed
    return user


def caller(user):
    return SimpleNamespace(oid=user.oid, owner=user.oid)


async def until(check, seconds=2.0):
    end = asyncio.get_running_loop().time() + seconds
    while not check():
        if asyncio.get_running_loop().time() > end:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.005)


class HubCase(unittest.IsolatedAsyncioTestCase):
    def make(self, azure=None, tail=True, wall=None, **settings):
        self.azure = azure or Azure()
        self.hubs = model_hub.ModelHub(
            self.azure.read_state,
            self.azure.read_tail if tail else None,
            model_hub.HubSettings(**{**FAST, **settings}),
            wall=wall or __import__("time").time,
        )
        self.addAsyncCleanup(self.stop_all)
        return self.hubs

    async def stop_all(self):
        for hub in list(self.hubs._hubs.values()):
            hub.stop()

    async def join(self, user, last_id=None, expires_at=None):
        return await self.hubs.subscribe(caller(user), user, SELECTION, last_id, expires_at)

    async def drain(self, subscription, count, timeout=1.0):
        out = []
        while len(out) < count:
            item = await subscription.next(timeout)
            if item is None:
                raise AssertionError(f"only {len(out)} of {count} events: {out}")
            out.append(item)
        return out


class LifecycleTests(HubCase):
    async def test_the_first_viewer_starts_the_poller_and_starts_from_a_snapshot(self):
        hubs = self.make()
        self.assertEqual(hubs.hub_count, 0)

        sub = await self.join(person("ada"))

        self.assertEqual(hubs.hub_count, 1)
        self.assertEqual([event["event"] for event in sub.initial], ["snapshot"])
        self.assertEqual(sub.initial[0]["data"]["entities"][0]["name"], "a")
        self.assertIsNotNone(hubs.warm(SELECTION))
        self.assertEqual(self.azure.reads[0], "ada")

    async def test_the_poller_stops_a_grace_period_after_the_last_viewer_and_reads_no_more(self):
        hubs = self.make()
        first, second = await self.join(person("ada")), await self.join(person("bob"))
        first.close()
        await asyncio.sleep(0.12)
        self.assertEqual(hubs.hub_count, 1, "one viewer is left")

        second.close()
        await until(lambda: hubs.hub_count == 0)
        reads = len(self.azure.reads)
        await asyncio.sleep(0.06)

        self.assertEqual(len(self.azure.reads), reads)
        self.assertIsNone(hubs.warm(SELECTION))

    async def test_a_viewer_who_returns_within_the_grace_period_finds_the_same_hub(self):
        hubs = self.make(grace_seconds=0.3)
        first = await self.join(person("ada"))
        epoch = hubs.warm(SELECTION).epoch
        first.close()

        again = await self.join(person("bob"))

        self.assertEqual(hubs.warm(SELECTION).epoch, epoch)
        self.assertEqual(again.initial[0]["event"], "snapshot")

    async def test_a_model_has_one_hub_for_all_its_viewers_whatever_the_case_of_its_name(self):
        hubs = self.make()
        await self.join(person("ada"))
        await hubs.subscribe(SimpleNamespace(oid="bob", owner="bob"), person("bob"), ("SUB", "RG", "HM"))

        self.assertEqual(hubs.hub_count, 1)

    async def test_a_first_read_that_fails_refuses_the_viewer_and_leaves_no_hub(self):
        azure = Azure()
        azure.errors["ada"] = http_error(404)
        hubs = self.make(azure)

        with self.assertRaises(HttpResponseError):
            await self.join(person("ada"))

        self.assertEqual(hubs.hub_count, 0)


class SharingTests(HubCase):
    async def test_one_viewer_reads_for_all_and_every_viewer_gets_the_change(self):
        hubs = self.make()
        ada, bob = await self.join(person("ada")), await self.join(person("bob"))
        self.azure.change(entity("a", "Degraded"), entity("b"))

        (first,), (second,) = await self.drain(ada, 1), await self.drain(bob, 1)

        self.assertEqual(first["event"], "delta")
        self.assertEqual(first["data"]["entities"]["upsert"][0]["healthState"], "Degraded")
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(set(self.azure.reads), {"ada"})
        self.assertEqual(hubs.hub_count, 1)

    async def test_nothing_changed_is_nothing_sent(self):
        self.make()
        sub = await self.join(person("ada"))
        await asyncio.sleep(0.1)

        self.assertIsNone(await sub.next(0.01))

    async def test_a_state_change_reads_its_history_tail_with_an_overlap_and_merges_by_key(self):
        self.make()
        self.azure.tail_result = {"transitions": [{"entity": "a", "t": 5, "from": 1, "to": 2, "reason": "SignalTransition"}]}
        sub = await self.join(person("ada"))
        self.azure.change(entity("a", "Degraded"), entity("b"))

        (event,) = await self.drain(sub, 1)

        self.assertEqual(event["data"]["timeline"]["transitions"], self.azure.tail_result["transitions"])
        user, since, annotations = self.azure.tails[0]
        self.assertEqual((user, list(since), annotations), ("ada", ["a"], []))
        self.azure.change(entity("a", "Degraded", at="2026-11-11T10:01:00Z"), entity("b"))
        (later,) = await self.drain(sub, 1)
        self.assertNotIn("transitions", later["data"].get("timeline", {}))

    async def test_a_new_evaluation_is_a_new_point_without_any_history_call(self):
        self.make()
        sub = await self.join(person("ada"))
        self.azure.change(entity("a", at="2026-11-11T10:01:00Z", value=2.0), entity("b"))

        (event,) = await self.drain(sub, 1)

        point = event["data"]["timeline"]["points"][0]
        self.assertEqual((point["entity"], point["points"][0][1]), ("a", 2.0))
        self.assertEqual(self.azure.tails, [])

    async def test_a_tail_that_failed_is_tried_again_on_the_next_read(self):
        self.make()
        self.azure.tail_error = http_error(500)
        sub = await self.join(person("ada"))
        self.azure.change(entity("a", "Degraded"), entity("b"))
        await self.drain(sub, 1)

        self.azure.tail_error = None
        self.azure.tail_result = {"transitions": [{"entity": "a", "t": 9, "from": 1, "to": 2, "reason": None}]}
        await until(lambda: len(self.azure.tails) >= 2)
        (event,) = await self.drain(sub, 1)

        self.assertEqual(event["data"]["timeline"]["transitions"][0]["t"], 9)


class CredentialTests(HubCase):
    async def test_a_first_read_that_no_viewer_can_be_exchanged_for_refuses_the_viewer(self):
        azure = Azure()
        azure.errors["ada"] = ClientAuthenticationError(message="exchange failed")
        hubs = self.make(azure)

        with self.assertRaises(ClientAuthenticationError):
            await self.join(person("ada"))

        self.assertEqual(hubs.hub_count, 0)

    async def test_a_second_viewer_takes_over_reading_when_the_first_leaves(self):
        self.make()
        ada, bob = await self.join(person("ada")), await self.join(person("bob"))
        self.azure.reads.clear()
        ada.close()
        self.azure.change(entity("a", "Degraded"), entity("b"))

        await self.drain(bob, 1)

        self.assertEqual(set(self.azure.reads), {"bob"})

    async def test_a_reader_whose_exchange_starts_failing_is_replaced_by_the_next_viewer(self):
        self.make()
        ada, bob = await self.join(person("ada")), await self.join(person("bob"))
        self.azure.errors["ada"] = ClientAuthenticationError(message="expired")
        self.azure.change(entity("a", "Unhealthy"), entity("b"))

        (event,) = await self.drain(bob, 1)

        self.assertEqual(event["data"]["entities"]["upsert"][0]["healthState"], "Unhealthy")
        self.assertIn("bob", self.azure.reads)
        del ada

    async def test_when_nobody_can_be_exchanged_the_data_goes_stale_and_the_viewers_stay(self):
        hubs = self.make()
        ada = await self.join(person("ada"))
        self.azure.errors["ada"] = ClientAuthenticationError(message="expired")
        await asyncio.sleep(0.1)

        self.assertEqual(hubs.hub_count, 1)
        self.assertIsNone(await ada.next(0.01))

    async def test_a_first_read_by_a_viewer_who_cannot_be_exchanged_falls_to_the_viewer_waiting_behind(self):
        azure = Azure()
        azure.errors["ada"] = ClientAuthenticationError(message="no")
        hubs = self.make(azure)
        results = await asyncio.gather(self.join(person("ada")), self.join(person("bob")), return_exceptions=True)

        self.assertIsInstance(results[1], model_hub.Subscription)
        self.assertEqual(hubs.hub_count, 1)


class AdmissionTests(HubCase):
    async def test_access_is_checked_again_as_each_viewer_and_a_refused_viewer_is_told_and_removed(self):
        hubs = self.make()
        ada, bob = person("ada"), person("bob")
        first, second = await self.join(ada), await self.join(bob)
        bob.allowed = False

        (closed,) = await self.drain(second, 1)

        self.assertEqual((closed.kind, closed.reason, closed.error["code"]), ("error", "forbidden", "forbidden"))
        self.assertIsNone(await first.next(0.02))
        self.assertEqual(len(hubs.warm(SELECTION).members), 1)

    async def test_a_viewer_whose_token_expires_is_told_to_reconnect_and_the_others_carry_on(self):
        clock = SimpleNamespace(now=1000.0)
        hubs = self.make(wall=lambda: clock.now)
        short = await self.join(person("ada"), expires_at=1010.0)
        long = await self.join(person("bob"), expires_at=9999.0)
        clock.now = 1011.0

        closed = await short.next(1)

        self.assertEqual((closed.kind, closed.reason), ("reconnect", "token_expired"))
        self.assertIsNone(await long.next(0.02))
        self.assertEqual(hubs.hub_count, 1)

    async def test_the_poller_never_reads_with_an_expired_token(self):
        clock = SimpleNamespace(now=1000.0)
        self.make(wall=lambda: clock.now)
        await self.join(person("ada"), expires_at=1010.0)
        await self.join(person("bob"), expires_at=9999.0)
        clock.now = 1011.0
        self.azure.reads.clear()
        await asyncio.sleep(0.08)

        self.assertEqual(set(self.azure.reads), {"bob"})


class LimitTests(HubCase):
    async def test_the_number_of_hubs_is_bounded(self):
        hubs = self.make(max_hubs=2)
        user = person("ada")
        for name in ("m1", "m2"):
            await hubs.subscribe(caller(person(name)), person(name), ("s", "rg", name))

        with self.assertRaises(model_hub.Refusal) as refused:
            await hubs.subscribe(caller(user), user, ("s", "rg", "m3"))

        self.assertEqual(refused.exception.code, "live_unavailable")

    async def test_the_number_of_viewers_of_a_model_is_bounded(self):
        hubs = self.make(max_subscribers=2)
        for name in ("u1", "u2"):
            await self.join(person(name))

        with self.assertRaises(model_hub.Refusal) as refused:
            await self.join(person("u3"))

        self.assertEqual(refused.exception.code, "too_many_subscribers")
        self.assertEqual(hubs.hub_count, 1)

    async def test_the_number_of_streams_of_one_account_is_bounded(self):
        self.make(max_streams_per_user=2)
        user = person("ada")
        await self.join(user)
        await self.join(user)

        with self.assertRaises(model_hub.Refusal) as refused:
            await self.join(user)

        self.assertEqual(refused.exception.code, "too_many_streams")


class QueueTests(HubCase):
    async def test_a_viewer_that_does_not_read_is_dropped_with_a_resync_and_the_queue_never_grows_past_its_bound(self):
        hubs = self.make(queue_size=2, poll_seconds=0.005)
        slow, quick = await self.join(person("ada")), await self.join(person("bob"))
        seen = []

        async def read_quick():
            while True:
                item = await quick.next(1)
                seen.append(item)

        reader = asyncio.create_task(read_quick())
        for value in range(1, 8):
            self.azure.change(entity("a", at=f"2026-11-11T10:0{value}:00Z", value=float(value)), entity("b"))
            await asyncio.sleep(0.03)
        reader.cancel()

        closed = [item for item in await self.drain(slow, 1)]
        self.assertEqual((closed[0].kind, closed[0].reason), ("resync", "slow"))
        self.assertLessEqual(slow._member.queue.qsize(), 3)
        self.assertGreaterEqual(len([item for item in seen if getattr(item, "get", None)]), 5)
        del hubs


class ResumeTests(HubCase):
    async def test_a_viewer_that_drops_and_comes_back_with_its_last_id_gets_exactly_what_it_missed(self):
        self.make()
        stays = await self.join(person("bob"))
        first = await self.join(person("ada"))
        self.azure.change(entity("a", value=2.0, at="2026-11-11T10:01:00Z"), entity("b"))
        (one,) = await self.drain(first, 1)
        first.close()
        self.azure.change(entity("a", value=3.0, at="2026-11-11T10:02:00Z"), entity("b"))
        await until(lambda: self.hubs.warm(SELECTION).seq >= 2)
        self.azure.change(entity("a", value=4.0, at="2026-11-11T10:03:00Z"), entity("b"))
        await until(lambda: self.hubs.warm(SELECTION).seq >= 3)

        again = await self.join(person("ada"), last_id=one["id"])

        self.assertEqual([event["event"] for event in again.initial], ["delta", "delta"])
        self.assertEqual([event["data"]["timeline"]["points"][0]["points"][0][1] for event in again.initial], [3.0, 4.0])
        del stays

    async def test_an_id_from_another_life_of_the_hub_or_too_old_or_bad_starts_from_a_snapshot(self):
        hubs = self.make(ring_size=2, poll_seconds=0.005)
        first = await self.join(person("ada"))
        old = first.initial[0]["id"]
        for value in range(1, 6):
            self.azure.change(entity("a", value=float(value), at=f"2026-11-11T10:0{value}:00Z"), entity("b"))
            await until(lambda value=value: hubs.warm(SELECTION).seq >= value)
        table = [("an id of another hub", "deadbeef-3"), ("an id too old for the ring", old), ("not an id", "x"), ("nothing", None)]

        for label, last_id in table:
            with self.subTest(label):
                again = await self.join(person("bob"), last_id=last_id)

                self.assertEqual([event["event"] for event in again.initial], ["snapshot"])
                again.close()

    async def test_a_snapshot_carries_the_id_of_the_last_event_so_the_next_resume_starts_after_it(self):
        hubs = self.make()
        sub = await self.join(person("ada"))
        self.azure.change(entity("a", value=2.0, at="2026-11-11T10:01:00Z"), entity("b"))
        await until(lambda: hubs.warm(SELECTION).seq >= 1)

        late = await self.join(person("bob"))
        parsed = live_data.parse_event_id(late.initial[0]["id"])

        self.assertEqual(parsed, (hubs.warm(SELECTION).epoch, 1))
        again = await self.join(person("bob"), last_id=late.initial[0]["id"])
        self.assertEqual(again.initial, [])
        del sub


class RefreshTests(HubCase):
    async def test_a_write_is_read_and_pushed_at_once_without_waiting_for_the_poll(self):
        hubs = self.make(poll_seconds=30)
        sub = await self.join(person("ada"))
        reads = len(self.azure.reads)
        self.azure.change(entity("a", "Unhealthy"), entity("b"))

        refreshed = await hubs.refresh(SELECTION, person("ada"))
        (event,) = await self.drain(sub, 1, timeout=0.5)

        self.assertTrue(refreshed)
        self.assertEqual(len(self.azure.reads), reads + 1)
        self.assertEqual(event["data"]["entities"]["upsert"][0]["healthState"], "Unhealthy")
        state = {item["name"]: item["healthState"] for item in hubs.warm(SELECTION).inventory["entities"]}
        self.assertEqual(state["a"], "Unhealthy")

    async def test_the_refresh_reads_as_the_user_who_wrote(self):
        hubs = self.make(poll_seconds=30)
        await self.join(person("ada"))
        self.azure.reads.clear()

        await hubs.refresh(SELECTION, person("bob"))

        self.assertEqual(self.azure.reads, ["bob"])

    async def test_a_refresh_that_fails_stops_the_snapshot_being_served_until_a_read_succeeds(self):
        hubs = self.make(poll_seconds=30)
        await self.join(person("ada"))
        self.azure.errors["bob"] = http_error(500)

        refreshed = await hubs.refresh(SELECTION, person("bob"))

        self.assertFalse(refreshed)
        self.assertIsNone(hubs.warm(SELECTION))
        self.azure.errors.clear()
        self.assertTrue(await hubs.refresh(SELECTION, person("bob")))
        self.assertIsNotNone(hubs.warm(SELECTION))

    async def test_a_model_nobody_watches_has_nothing_to_refresh(self):
        hubs = self.make()

        self.assertFalse(await hubs.refresh(SELECTION, person("ada")))
        self.assertEqual(self.azure.reads, [])


class BackoffTests(HubCase):
    async def test_how_long_the_poller_waits_after_a_failure(self):
        self.make()
        sub = await self.join(person("ada"))
        hub = self.hubs.warm(SELECTION)
        poll = hub.settings.poll_seconds
        table = [
            ("a server error doubles", http_error(500), poll, poll * 2),
            ("it doubles again", http_error(500), poll * 2, poll * 4),
            ("it stops at the cap", http_error(500), 200, 300),
            ("busy waits at least a minute", http_error(429), poll, 60),
            ("unavailable waits at least a minute", http_error(503), poll, 60),
            ("a busy service backs off further", http_error(429), 100, 200),
        ]
        for label, error, delay, expected in table:
            with self.subTest(label):
                self.assertAlmostEqual(hub.after_failure(error, delay), expected)
        del sub

    async def test_a_failing_service_is_read_less_often_and_recovers(self):
        azure = Azure()
        self.make(azure, poll_seconds=0.01)
        sub = await self.join(person("ada"))
        azure.errors["ada"] = http_error(500)
        await asyncio.sleep(0.2)
        failing = len(azure.reads)

        self.assertLess(failing, 15, "backing off, not hammering")
        azure.errors.clear()
        del sub


if __name__ == "__main__":
    unittest.main()
