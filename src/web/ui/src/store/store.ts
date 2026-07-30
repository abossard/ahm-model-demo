import { configureStore } from "@reduxjs/toolkit";
import { useDispatch, useSelector } from "react-redux";
import { modelReducer } from "./modelSlice";
import { entityReducer } from "./entitySlice";
import { reportReducer } from "./reportSlice";
import { journeyReducer } from "./journeySlice";
import { uiReducer } from "./uiSlice";

export const store = configureStore({
  reducer: {
    model: modelReducer,
    entity: entityReducer,
    report: reportReducer,
    journey: journeyReducer,
    ui: uiReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
