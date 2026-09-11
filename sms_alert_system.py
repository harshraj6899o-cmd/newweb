"""
NER Logistics Intelligence Platform
SMS Alert System with Sound Notifications
------------------------------------------
Sends SMS alerts for route disruptions, blocked roads, delayed
deliveries, and high-risk transport corridors, and plays a local
sound so control-room / field staff notice new alerts immediately.

Install dependencies:
    pip install twilio playsound==1.2.2

Configure (env vars or pass directly to SMSSender):
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_FROM_NUMBER

If Twilio credentials are not set, SMS sending is simulated (logged
only) so the rest of the pipeline can still be tested end-to-end.
Place alert sound files under ./sounds/ (see SOUND_MAP below).
"""

import os
import time
import json
import queue
import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

try:
    from twilio.rest import Client
    from twilio.base.exceptions import TwilioRestException
    TWILIO_AVAILABLE = True
except ImportError:
    TWILIO_AVAILABLE = False

try:
    from playsound import playsound
    SOUND_AVAILABLE = True
except ImportError:
    SOUND_AVAILABLE = False

try:
    import winsound
    WINDOWS_SOUND_AVAILABLE = True
except ImportError:
    WINDOWS_SOUND_AVAILABLE = False


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("sms_alert_system.log"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("NER-SMS-Alert")


class Severity(Enum):
    NORMAL = "NORMAL"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


# Map severity -> local sound file. Drop your own .wav/.mp3 files here.
SOUND_MAP = {
    Severity.NORMAL: "sounds/normal_alert.wav",
    Severity.LOW: "sounds/low_alert.wav",
    Severity.MEDIUM: "sounds/medium_alert.wav",
    Severity.HIGH: "sounds/high_alert.wav",
    Severity.CRITICAL: "sounds/critical_alert.wav",
}

# Minimal multilingual SMS templates (extend as needed)
TEMPLATES = {
    "en": "[NER-ALERT] {severity}: {message} | Location: {location} | Time: {time}",
    "hi": "[NER-ALERT] {severity}: {message} | स्थान: {location} | समय: {time}",
    "as": "[NER-ALERT] {severity}: {message} | অৱস্থান: {location} | সময়: {time}",
}


@dataclass
class Alert:
    message: str
    location: str
    severity: Severity
    phone_numbers: list
    language: str = "en"
    timestamp: datetime = field(default_factory=datetime.now)

    def render_text(self) -> str:
        template = TEMPLATES.get(self.language, TEMPLATES["en"])
        return template.format(
            severity=self.severity.value,
            message=self.message,
            location=self.location,
            time=self.timestamp.strftime("%d-%b %H:%M"),
        )


class SoundNotifier:
    """Plays a local sound whenever a new alert is dispatched."""

    @staticmethod
    def _beep_pattern(severity: Severity):
        patterns = {
            Severity.NORMAL: [(520, 100)],
            Severity.LOW: [(440, 120)],
            Severity.MEDIUM: [(520, 100), (620, 100)],
            Severity.HIGH: [(620, 110), (520, 110), (620, 110)],
            Severity.CRITICAL: [(760, 140), (520, 140), (760, 140), (520, 140)],
        }
        for frequency, duration in patterns.get(severity, patterns[Severity.NORMAL]):
            winsound.Beep(frequency, duration)

    def notify(self, severity: Severity):
        if not SOUND_AVAILABLE and WINDOWS_SOUND_AVAILABLE:
            threading.Thread(target=self._beep_pattern, args=(severity,), daemon=True).start()
            return
        if not SOUND_AVAILABLE:
            logger.warning(
                "playsound not installed - skipping audio alert "
                "(pip install playsound==1.2.2 or run on Windows for native beeps)"
            )
            return
        sound_file = SOUND_MAP.get(severity)
        if sound_file and os.path.exists(sound_file):
            try:
                # Play in a background thread so SMS dispatch never blocks on audio
                threading.Thread(target=playsound, args=(sound_file,), daemon=True).start()
            except Exception as e:
                logger.error(f"Failed to play alert sound: {e}")
        else:
            logger.warning(f"Sound file missing for {severity.value}: {sound_file}")


class SMSSender:
    """Wraps Twilio SMS sending with retries. Falls back to simulation if unconfigured."""

    def __init__(self, account_sid=None, auth_token=None, from_number=None):
        self.account_sid = account_sid or os.getenv("TWILIO_ACCOUNT_SID")
        self.auth_token = auth_token or os.getenv("TWILIO_AUTH_TOKEN")
        self.from_number = from_number or os.getenv("TWILIO_FROM_NUMBER")
        self.client = None
        if TWILIO_AVAILABLE and self.account_sid and self.auth_token and self.from_number:
            try:
                self.client = Client(self.account_sid, self.auth_token)
            except Exception as e:
                logger.error(f"Twilio client initialization failed: {e}")
                self.client = None
        else:
            logger.warning("Twilio not configured - SMS will be simulated (logged, not sent).")

    def send(self, to_number: str, body: str, max_retries: int = 3) -> bool:
        if not self.client:
            logger.info(f"[SIMULATED SMS] to {to_number}: {body}")
            return True

        for attempt in range(1, max_retries + 1):
            try:
                msg = self.client.messages.create(body=body, from_=self.from_number, to=to_number)
                logger.info(f"SMS sent to {to_number} (sid={msg.sid})")
                return True
            except Exception as e:
                # Covers Twilio API errors plus transient network/client errors.
                logger.error(f"Attempt {attempt}/{max_retries} failed for {to_number}: {e}")
                if attempt < max_retries:
                    time.sleep(2 * attempt)
        logger.error(f"All retries failed for {to_number}. Queuing for offline retry.")
        return False


class OfflineQueue:
    """Persists undeliverable alerts so they can be retried once network returns
    (important for low-connectivity NER districts)."""

    def __init__(self, path="offline_queue.jsonl"):
        self.path = path
        self._lock = threading.Lock()

    def enqueue(self, alert: Alert, to_number: str):
        record = {
            "to": to_number,
            "text": alert.render_text(),
            "severity": alert.severity.value,
            "queued_at": datetime.now().isoformat(),
        }
        with self._lock, open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        logger.info(f"Queued offline SMS for {to_number}")

    def flush(self, sms_sender: SMSSender):
        if not os.path.exists(self.path):
            return
        with self._lock:
            with open(self.path, "r", encoding="utf-8") as f:
                lines = f.readlines()
            remaining = []
            for line in lines:
                record = json.loads(line)
                ok = sms_sender.send(record["to"], record["text"])
                if not ok:
                    remaining.append(line)
            with open(self.path, "w", encoding="utf-8") as f:
                f.writelines(remaining)
        logger.info(f"Offline queue flush complete. {len(remaining)} alert(s) still pending.")


class AlertDispatcher:
    """Central dispatcher: queues incoming alerts, plays sound, sends SMS in the background."""

    def __init__(self, sms_sender: SMSSender):
        self.sms_sender = sms_sender
        self.sound_notifier = SoundNotifier()
        self.offline_queue = OfflineQueue()
        self._q = queue.Queue()
        self._worker = threading.Thread(target=self._process_loop, daemon=True)
        self._worker.start()

    def dispatch(self, alert: Alert):
        self._q.put(alert)

    def _process_loop(self):
        while True:
            alert: Alert = self._q.get()
            try:
                self._handle(alert)
            finally:
                self._q.task_done()

    def _handle(self, alert: Alert):
        logger.info(f"Processing {alert.severity.value} alert: {alert.message} @ {alert.location}")
        self.sound_notifier.notify(alert.severity)
        text = alert.render_text()
        for number in alert.phone_numbers:
            ok = self.sms_sender.send(number, text)
            if not ok:
                self.offline_queue.enqueue(alert, number)

    def wait_until_idle(self, timeout=None):
        """Block until all currently queued alerts have been processed.

        Python's Queue.join() has no timeout, so when a timeout is supplied
        we wait in small intervals without changing the queue semantics.
        """
        if timeout is None:
            self._q.join()
            return

        deadline = time.monotonic() + max(0, timeout)
        while self._q.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.05)


if __name__ == "__main__":
    sender = SMSSender()
    dispatcher = AlertDispatcher(sender)

    # --- Demo: simulate a landslide disruption alert ---
    demo_alert = Alert(
        message="Landslide reported, road blocked",
        location="NH-13, Dima Hasao, Assam",
        severity=Severity.CRITICAL,
        phone_numbers=["+91XXXXXXXXXX"],  # replace with real recipient numbers
        language="en",
    )
    dispatcher.dispatch(demo_alert)

    # --- Demo: a medium-severity delivery delay alert ---
    delay_alert = Alert(
        message="Medicine consignment delayed by 4 hours",
        location="Tawang - Bomdila route",
        severity=Severity.MEDIUM,
        phone_numbers=["+91YYYYYYYYYY"],
        language="en",
    )
    dispatcher.dispatch(delay_alert)

    dispatcher.wait_until_idle()
    time.sleep(1)
    dispatcher.offline_queue.flush(sender)  # retry anything that failed
