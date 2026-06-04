import { doc, updateDoc, serverTimestamp, collection, addDoc, getFirestore } from 'firebase/firestore';

const db = getFirestore();

export const softDeleteRecord = async (
  collectionName: string,
  docId: string,
  user: { email: string; role: string }
) => {
  const docRef = doc(db, collectionName, docId);
  
  // 1. Soft delete
  await updateDoc(docRef, {
    isDeleted: true,
    deletedAt: serverTimestamp(),
    deletedBy: user.email,
  });

  // 2. Audit log
  await addDoc(collection(db, 'audit_logs'), {
    action: 'SOFT_DELETE',
    collection: collectionName,
    documentId: docId,
    modifiedBy: user.email,
    modifiedAt: serverTimestamp(),
  });
};

export const restoreRecord = async (
  collectionName: string,
  docId: string,
  user: { email: string; role: string }
) => {
  const docRef = doc(db, collectionName, docId);
  
  // 1. Restore
  await updateDoc(docRef, {
    isDeleted: false,
    restoredAt: serverTimestamp(),
    restoredBy: user.email,
  });

  // 2. Audit log
  await addDoc(collection(db, 'audit_logs'), {
    action: 'RESTORE',
    collection: collectionName,
    documentId: docId,
    modifiedBy: user.email,
    modifiedAt: serverTimestamp(),
  });
};
