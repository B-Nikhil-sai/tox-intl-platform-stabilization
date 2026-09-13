import logging
import time

from bson import ObjectId
from pymongo import MongoClient

from app.celery_app import celery
from app.config import MOCK_PROCESSING_DELAY_SECONDS, MONGODB_URI
from app.mock_ai import extract_document

logger = logging.getLogger(__name__)


def processing_delay(attempt: int) -> float:
    if attempt == 1:
        return MOCK_PROCESSING_DELAY_SECONDS * 2
    return max(0.5, MOCK_PROCESSING_DELAY_SECONDS / 2)


@celery.task(name="app.tasks.process_document", bind=True, max_retries=2)
def process_document(
    self,
    document_id: str,
    organisation_id: str,
    attempt: int,
    file_name: str,
    source_text: str,
) -> dict[str, object]:
    client = MongoClient(MONGODB_URI)
    records = client.get_database()["documentrecords"]
    object_id = ObjectId(document_id)

    logger.info(
        "document_processing_started document_id=%s organisation_id=%s attempt=%s",
        document_id,
        organisation_id,
        attempt,
    )
    records.update_one({"_id": object_id, "attempt": attempt}, {"$set": {"status": "processing"}})

    try:
        time.sleep(processing_delay(attempt))
        result = extract_document(source_text)
        result["summary"] = f"{result['summary']} (attempt {attempt})"

        records.update_one(
            {"_id": object_id, "attempt": attempt},
            {
                "$set": {
                    "status": "completed",
                    "result": result,
                    "errorMessage": None,
                }
            },
        )
        logger.info(
            "document_processing_completed document_id=%s attempt=%s file_name=%s",
            document_id,
            attempt,
            file_name,
        )
        return {"documentId": document_id, "attempt": attempt, "status": "completed"}
    except Exception as exc:
        records.update_one(
            {"_id": object_id, "attempt": attempt},
            {"$set": {"status": "failed", "errorMessage": "Processing failed"}},
        )
        logger.exception("document_processing_failed document_id=%s attempt=%s", document_id, attempt)
        raise self.retry(exc=exc, countdown=2**self.request.retries) from exc
    finally:
        client.close()
